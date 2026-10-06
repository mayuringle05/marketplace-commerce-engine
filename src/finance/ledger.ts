import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";
import { transitionOrder } from "../orders/state-machine.ts";
import { consumeReservation } from "../orders/reservations.ts";

export type LedgerEntryType =
  | "CUSTOMER_REVENUE"
  | "MARKETPLACE_FEE"
  | "LOGISTICS"
  | "SUPPLIER_PAYABLE"
  | "PACKING"
  | "TAX_OUTPUT"
  | "TAX_INPUT_CREDIT"
  | "WITHHOLDING_ASSET"
  | "REFUND"
  | "RETURN_RECOVERY"
  | "SETTLEMENT"
  | "ADJUSTMENT";

export interface FinancialEventInput {
  readonly orderId: string | null;
  readonly externalEventId: string;
  readonly entryType: LedgerEntryType;
  readonly amountPaise: number;
  readonly recognized: boolean;
  readonly provisional: boolean;
  readonly sourceRef: string;
  readonly eventAt: string;
  readonly createdAt: string;
}

export function recordFinancialEvent(
  database: DatabaseSync,
  input: FinancialEventInput,
): string {
  if (!Number.isSafeInteger(input.amountPaise)) {
    throw new Error("Ledger amount must be a safe integer.");
  }

  const id = deterministicId(
    "ledger",
    input.externalEventId,
    input.entryType,
  );

  database
    .prepare(
      `
        INSERT OR IGNORE INTO ledger_entries (
          id,
          order_id,
          external_event_id,
          entry_type,
          amount_paise,
          recognized,
          provisional,
          source_ref,
          event_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.orderId,
      input.externalEventId,
      input.entryType,
      input.amountPaise,
      input.recognized ? 1 : 0,
      input.provisional ? 1 : 0,
      input.sourceRef,
      input.eventAt,
      input.createdAt,
    );

  return id;
}

export function recognizedOrderProfitPaise(
  database: DatabaseSync,
  orderId: string,
): bigint {
  const row = database
    .prepare(
      `
        SELECT COALESCE(SUM(amount_paise), 0) AS amount
        FROM ledger_entries
        WHERE order_id = ?
          AND recognized = 1
          AND provisional = 0
      `,
    )
    .get(orderId) as { amount: bigint };

  return row.amount;
}

export interface KeptSettlementInput {
  readonly orderId: string;
  readonly customerRevenuePaise: number;
  readonly marketplaceFeePaise: number;
  readonly logisticsPaise: number;
  readonly supplierPayablePaise: number;
  readonly packingPaise: number;
  readonly overheadPaise: number;
  readonly settlementCashPaise: number;
  readonly sourceRef: string;
  readonly settledAt: string;
}

export function reconcileDeliveredKeptOrder(
  database: DatabaseSync,
  input: KeptSettlementInput,
): bigint {
  const order = database
    .prepare("SELECT state, version FROM orders WHERE id = ?")
    .get(input.orderId) as
    | { state: string; version: bigint }
    | undefined;

  if (order === undefined || order.state !== "DELIVERED") {
    throw new Error("Kept reconciliation requires DELIVERED order.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    transitionOrder(
      database,
      input.orderId,
      "DELIVERED",
      Number(order.version),
      "RECONCILING",
      input.settledAt,
    );

    const economic = [
      ["CUSTOMER_REVENUE", input.customerRevenuePaise],
      ["MARKETPLACE_FEE", -input.marketplaceFeePaise],
      ["LOGISTICS", -input.logisticsPaise],
      ["SUPPLIER_PAYABLE", -input.supplierPayablePaise],
      ["PACKING", -input.packingPaise],
      ["ADJUSTMENT", -input.overheadPaise],
    ] as const;

    for (const [entryType, amountPaise] of economic) {
      recordFinancialEvent(database, {
        orderId: input.orderId,
        externalEventId: `${input.sourceRef}:${entryType}`,
        entryType,
        amountPaise,
        recognized: true,
        provisional: false,
        sourceRef: input.sourceRef,
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      });
    }

    recordFinancialEvent(database, {
      orderId: input.orderId,
      externalEventId: `${input.sourceRef}:SETTLEMENT`,
      entryType: "SETTLEMENT",
      amountPaise: input.settlementCashPaise,
      recognized: false,
      provisional: false,
      sourceRef: input.sourceRef,
      eventAt: input.settledAt,
      createdAt: input.settledAt,
    });

    const current = database
      .prepare("SELECT version FROM orders WHERE id = ?")
      .get(input.orderId) as { version: bigint };

    transitionOrder(
      database,
      input.orderId,
      "RECONCILING",
      Number(current.version),
      "MATURED",
      input.settledAt,
    );

    consumeReservation(database, input.orderId, input.settledAt);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return recognizedOrderProfitPaise(database, input.orderId);
}
