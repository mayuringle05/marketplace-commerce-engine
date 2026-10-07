import { DatabaseSync } from "node:sqlite";

export type SimulatedPurchaseOutcome =
  | "CONFIRM"
  | "REJECT"
  | "UNKNOWN";

export interface SupplierPurchaseRequest {
  readonly idempotencyKey: string;
  readonly clientPoRef: string;
  readonly supplierId: string;
  readonly supplierSku: string;
  readonly amountPaise: number;
  readonly quantity: number;
  readonly destinationKey: string;
  readonly submittedAt: string;
}

export interface SupplierPurchaseResult {
  readonly state: "CONFIRMED" | "REJECTED" | "UNKNOWN";
  readonly providerPoId: string | null;
}

export interface SupplierPurchaseAdapter {
  submit(request: SupplierPurchaseRequest): SupplierPurchaseResult;
  reconcile(request: SupplierPurchaseRequest): SupplierPurchaseResult;
}

export class SimulatedSupplierPurchaseAdapter
  implements SupplierPurchaseAdapter
{
  readonly database: DatabaseSync;
  nextOutcome: SimulatedPurchaseOutcome;
  beforeReturn:
    | ((request: SupplierPurchaseRequest) => void)
    | null = null;

  constructor(
    path = ":memory:",
    nextOutcome: SimulatedPurchaseOutcome = "CONFIRM",
  ) {
    this.database = new DatabaseSync(path, {
      readBigInts: true,
      timeout: 5_000,
    });
    this.nextOutcome = nextOutcome;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS supplier_purchase_history (
        idempotency_key TEXT PRIMARY KEY,
        provider_po_id TEXT NOT NULL UNIQUE,
        client_po_ref TEXT NOT NULL UNIQUE,
        supplier_id TEXT NOT NULL,
        supplier_sku TEXT NOT NULL,
        amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        destination_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('CONFIRMED', 'REJECTED')
        ),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  submit(
    request: SupplierPurchaseRequest,
  ): SupplierPurchaseResult {
    const existing = this.reconcile(request);
    if (existing.state !== "UNKNOWN") {
      return existing;
    }

    if (this.nextOutcome === "UNKNOWN") {
      this.beforeReturn?.(request);
      return {
        state: "UNKNOWN",
        providerPoId: null,
      };
    }

    const providerPoId = `SIMPO-${request.clientPoRef}`;
    const state =
      this.nextOutcome === "CONFIRM"
        ? "CONFIRMED"
        : "REJECTED";

    this.database
      .prepare(
        `
          INSERT INTO supplier_purchase_history (
            idempotency_key,
            provider_po_id,
            client_po_ref,
            supplier_id,
            supplier_sku,
            amount_paise,
            quantity,
            destination_key,
            state,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        request.idempotencyKey,
        providerPoId,
        request.clientPoRef,
        request.supplierId,
        request.supplierSku,
        request.amountPaise,
        request.quantity,
        request.destinationKey,
        state,
        request.submittedAt,
      );

    this.beforeReturn?.(request);

    return {
      state,
      providerPoId,
    };
  }

  reconcile(
    request: SupplierPurchaseRequest,
  ): SupplierPurchaseResult {
    const row = this.database
      .prepare(
        `
          SELECT
            provider_po_id,
            supplier_id,
            supplier_sku,
            amount_paise,
            quantity,
            destination_key,
            state
          FROM supplier_purchase_history
          WHERE idempotency_key = ?
      `,
      )
      .get(request.idempotencyKey) as
      | {
          provider_po_id: string;
          supplier_id: string;
          supplier_sku: string;
          amount_paise: bigint;
          quantity: bigint;
          destination_key: string;
          state: "CONFIRMED" | "REJECTED";
        }
      | undefined;

    if (row === undefined) {
      return {
        state: "UNKNOWN",
        providerPoId: null,
      };
    }

    if (
      row.supplier_id !== request.supplierId ||
      row.supplier_sku !== request.supplierSku ||
      row.amount_paise !== BigInt(request.amountPaise) ||
      row.quantity !== BigInt(request.quantity) ||
      row.destination_key !== request.destinationKey
    ) {
      throw new Error(
        "Provider history conflicts with the authorized purchase payload.",
      );
    }

    return {
      state: row.state,
      providerPoId: row.provider_po_id,
    };
  }

  recordRecoveredResult(
    request: SupplierPurchaseRequest,
    state: "CONFIRMED" | "REJECTED",
  ): string {
    const existing = this.reconcile(request);
    if (existing.state !== "UNKNOWN") {
      if (existing.state !== state) {
        throw new Error(
          "Recovered supplier state conflicts with provider history.",
        );
      }
      return existing.providerPoId!;
    }

    const previous = this.nextOutcome;
    this.nextOutcome =
      state === "CONFIRMED" ? "CONFIRM" : "REJECT";
    try {
      return this.submit(request).providerPoId!;
    } finally {
      this.nextOutcome = previous;
    }
  }

  close(): void {
    this.database.close();
  }
}
