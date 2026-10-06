import type { DatabaseSync } from "node:sqlite";

import {
  recognizedOrderProfitPaise,
  recordFinancialEvent,
} from "./ledger.ts";
import { consumeReservation } from "../orders/reservations.ts";
import { transitionOrder } from "../orders/state-machine.ts";

function orderVersion(
  database: DatabaseSync,
  orderId: string,
  expectedState: string,
): bigint {
  const row = database
    .prepare("SELECT state, version FROM orders WHERE id = ?")
    .get(orderId) as
    | { state: string; version: bigint }
    | undefined;

  if (row === undefined || row.state !== expectedState) {
    throw new Error(
      `Order must be in ${expectedState} for reconciliation.`,
    );
  }

  return row.version;
}

export interface LossReconciliationInput {
  readonly orderId: string;
  readonly supplierLossPaise: number;
  readonly logisticsLossPaise: number;
  readonly feeLossPaise: number;
  readonly recoveryPaise: number;
  readonly sourceRef: string;
  readonly reconciledAt: string;
}

export function reconcileRtoOrder(
  database: DatabaseSync,
  input: LossReconciliationInput,
): bigint {
  const version = orderVersion(database, input.orderId, "RTO");

  database.exec("BEGIN IMMEDIATE");
  try {
    transitionOrder(
      database,
      input.orderId,
      "RTO",
      Number(version),
      "RECONCILING",
      input.reconciledAt,
    );

    const entries = [
      ["SUPPLIER_PAYABLE", -input.supplierLossPaise],
      ["LOGISTICS", -input.logisticsLossPaise],
      ["MARKETPLACE_FEE", -input.feeLossPaise],
      ["RETURN_RECOVERY", input.recoveryPaise],
    ] as const;

    for (const [entryType, amountPaise] of entries) {
      recordFinancialEvent(database, {
        orderId: input.orderId,
        externalEventId: `${input.sourceRef}:${entryType}`,
        entryType,
        amountPaise,
        recognized: true,
        provisional: false,
        sourceRef: input.sourceRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      });
    }

    const current = database
      .prepare("SELECT version FROM orders WHERE id = ?")
      .get(input.orderId) as { version: bigint };

    transitionOrder(
      database,
      input.orderId,
      "RECONCILING",
      Number(current.version),
      "MATURED",
      input.reconciledAt,
    );

    consumeReservation(
      database,
      input.orderId,
      input.reconciledAt,
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return recognizedOrderProfitPaise(database, input.orderId);
}

export interface ReturnReconciliationInput {
  readonly orderId: string;
  readonly marketplaceReturnId: string;
  readonly refundEventId: string;
  readonly refundPaise: number;
  readonly feeLossPaise: number;
  readonly returnLogisticsPaise: number;
  readonly sourceRef: string;
  readonly reconciledAt: string;
}

export function reconcileClosedReturn(
  database: DatabaseSync,
  input: ReturnReconciliationInput,
): bigint {
  const version = orderVersion(
    database,
    input.orderId,
    "RETURN_OPEN",
  );

  const returnRow = database
    .prepare(
      `
        SELECT state, recovery_paise, refund_paise
        FROM returns
        WHERE order_id = ?
          AND marketplace_return_id = ?
      `,
    )
    .get(
      input.orderId,
      input.marketplaceReturnId,
    ) as
    | {
        state: string;
        recovery_paise: bigint;
        refund_paise: bigint;
      }
    | undefined;

  if (returnRow === undefined || returnRow.state !== "CLOSED") {
    throw new Error("Return must be CLOSED before reconciliation.");
  }

  if (returnRow.refund_paise !== BigInt(input.refundPaise)) {
    throw new Error("Refund amount does not match return record.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    transitionOrder(
      database,
      input.orderId,
      "RETURN_OPEN",
      Number(version),
      "RECONCILING",
      input.reconciledAt,
    );

    recordFinancialEvent(database, {
      orderId: input.orderId,
      externalEventId: input.refundEventId,
      entryType: "REFUND",
      amountPaise: -input.refundPaise,
      recognized: true,
      provisional: false,
      sourceRef: input.sourceRef,
      eventAt: input.reconciledAt,
      createdAt: input.reconciledAt,
    });

    const entries = [
      ["MARKETPLACE_FEE", -input.feeLossPaise],
      ["LOGISTICS", -input.returnLogisticsPaise],
      ["RETURN_RECOVERY", Number(returnRow.recovery_paise)],
    ] as const;

    for (const [entryType, amountPaise] of entries) {
      recordFinancialEvent(database, {
        orderId: input.orderId,
        externalEventId: `${input.marketplaceReturnId}:${entryType}`,
        entryType,
        amountPaise,
        recognized: true,
        provisional: false,
        sourceRef: input.sourceRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      });
    }

    const current = database
      .prepare("SELECT version FROM orders WHERE id = ?")
      .get(input.orderId) as { version: bigint };

    transitionOrder(
      database,
      input.orderId,
      "RECONCILING",
      Number(current.version),
      "MATURED",
      input.reconciledAt,
    );

    consumeReservation(
      database,
      input.orderId,
      input.reconciledAt,
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return recognizedOrderProfitPaise(database, input.orderId);
}
