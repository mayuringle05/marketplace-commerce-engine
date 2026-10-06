import type { DatabaseSync } from "node:sqlite";

export type SimulatedPurchaseOutcome =
  | "CONFIRM"
  | "REJECT"
  | "UNKNOWN";

export interface SimulatedPurchaseRequest {
  readonly idempotencyKey: string;
  readonly clientPoRef: string;
  readonly amountPaise: number;
  readonly quantity: number;
  readonly submittedAt: string;
}

export interface SimulatedPurchaseResult {
  readonly state: "CONFIRMED" | "REJECTED" | "UNKNOWN";
  readonly providerPoId: string | null;
}

export function submitSimulatedPurchase(
  database: DatabaseSync,
  request: SimulatedPurchaseRequest,
  outcome: SimulatedPurchaseOutcome,
): SimulatedPurchaseResult {
  const existing = database
    .prepare(
      `
        SELECT provider_po_id, state
        FROM simulated_supplier_orders
        WHERE idempotency_key = ?
      `,
    )
    .get(request.idempotencyKey) as
    | {
        provider_po_id: string;
        state: "CONFIRMED" | "REJECTED";
      }
    | undefined;

  if (existing !== undefined) {
    return {
      state: existing.state,
      providerPoId: existing.provider_po_id,
    };
  }

  if (outcome === "UNKNOWN") {
    return {
      state: "UNKNOWN",
      providerPoId: null,
    };
  }

  const providerPoId = `SIMPO-${request.clientPoRef}`;

  database
    .prepare(
      `
        INSERT INTO simulated_supplier_orders (
          idempotency_key,
          provider_po_id,
          client_po_ref,
          amount_paise,
          quantity,
          state,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      request.idempotencyKey,
      providerPoId,
      request.clientPoRef,
      request.amountPaise,
      request.quantity,
      outcome === "CONFIRM" ? "CONFIRMED" : "REJECTED",
      request.submittedAt,
    );

  return {
    state: outcome === "CONFIRM" ? "CONFIRMED" : "REJECTED",
    providerPoId,
  };
}

export function reconcileSimulatedPurchase(
  database: DatabaseSync,
  idempotencyKey: string,
): SimulatedPurchaseResult {
  const row = database
    .prepare(
      `
        SELECT provider_po_id, state
        FROM simulated_supplier_orders
        WHERE idempotency_key = ?
      `,
    )
    .get(idempotencyKey) as
    | {
        provider_po_id: string;
        state: "CONFIRMED" | "REJECTED";
      }
    | undefined;

  return row === undefined
    ? { state: "UNKNOWN", providerPoId: null }
    : {
        state: row.state,
        providerPoId: row.provider_po_id,
      };
}
