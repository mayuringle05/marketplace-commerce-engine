import type { DatabaseSync } from "node:sqlite";

import {
  recognizedOrderProfitPaise,
  recordFinancialEventV2,
  type FinancialEventV2Input,
} from "./ledger.ts";
import { consumeReservation } from "../orders/reservations.ts";
import { transitionOrder } from "../orders/state-machine.ts";
import { deterministicId } from "../core/deterministic.ts";

function requiredText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
}

function nonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

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

function recordOutcomeReconciliation(
  database: DatabaseSync,
  input: {
    orderId: string;
    outcomeType: "RTO" | "RETURN" | "LOST" | "DAMAGED";
    outcomeRef: string;
    marketplaceStatementRef: string;
    supplierInvoiceRef: string;
    bankEvidenceRef: string;
    expectedNetCashPaise: number;
    actualNetCashPaise: number;
    reconciledAt: string;
  },
): string {
  for (const [label, value] of [
    ["outcomeRef", input.outcomeRef],
    ["marketplaceStatementRef", input.marketplaceStatementRef],
    ["supplierInvoiceRef", input.supplierInvoiceRef],
    ["bankEvidenceRef", input.bankEvidenceRef],
  ] as const) {
    requiredText(value, label);
  }
  if (
    !Number.isSafeInteger(input.expectedNetCashPaise) ||
    !Number.isSafeInteger(input.actualNetCashPaise) ||
    input.expectedNetCashPaise !== input.actualNetCashPaise
  ) {
    throw new Error(
      "Outcome maturity requires exact expected-vs-bank cash reconciliation.",
    );
  }

  const id = deterministicId(
    "outcome",
    input.outcomeType,
    input.outcomeRef,
  );

  const existing = database
    .prepare(
      `
        SELECT
          order_id,
          marketplace_statement_ref,
          supplier_invoice_ref,
          bank_evidence_ref,
          expected_net_cash_paise,
          actual_net_cash_paise,
          reconciled_at
        FROM outcome_reconciliations
        WHERE outcome_type = ?
          AND outcome_ref = ?
      `,
    )
    .get(input.outcomeType, input.outcomeRef) as
    | {
        order_id: string;
        marketplace_statement_ref: string;
        supplier_invoice_ref: string;
        bank_evidence_ref: string;
        expected_net_cash_paise: bigint;
        actual_net_cash_paise: bigint;
        reconciled_at: string;
      }
    | undefined;

  if (existing !== undefined) {
    if (
      existing.order_id !== input.orderId ||
      existing.marketplace_statement_ref !==
        input.marketplaceStatementRef ||
      existing.supplier_invoice_ref !== input.supplierInvoiceRef ||
      existing.bank_evidence_ref !== input.bankEvidenceRef ||
      existing.expected_net_cash_paise !==
        BigInt(input.expectedNetCashPaise) ||
      existing.actual_net_cash_paise !==
        BigInt(input.actualNetCashPaise) ||
      existing.reconciled_at !== input.reconciledAt
    ) {
      throw new Error("Conflicting outcome reconciliation replay.");
    }
    return id;
  }

  database
    .prepare(
      `
        INSERT INTO outcome_reconciliations (
          id,
          order_id,
          outcome_type,
          outcome_ref,
          marketplace_statement_ref,
          supplier_invoice_ref,
          bank_evidence_ref,
          expected_net_cash_paise,
          actual_net_cash_paise,
          reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.orderId,
      input.outcomeType,
      input.outcomeRef,
      input.marketplaceStatementRef,
      input.supplierInvoiceRef,
      input.bankEvidenceRef,
      input.expectedNetCashPaise,
      input.actualNetCashPaise,
      input.reconciledAt,
    );

  return id;
}

export interface LossReconciliationInput {
  readonly orderId: string;
  readonly supplierLossPaise: number;
  readonly logisticsLossPaise: number;
  readonly feeLossPaise: number;
  readonly recoveryPaise: number;
  readonly outcomeRef: string;
  readonly marketplaceStatementRef: string;
  readonly supplierInvoiceRef: string;
  readonly bankEvidenceRef: string;
  readonly expectedNetCashPaise: number;
  readonly actualNetCashPaise: number;
  readonly reconciledAt: string;
}

export function reconcileRtoOrder(
  database: DatabaseSync,
  input: LossReconciliationInput,
): bigint {
  for (const [label, value] of [
    ["supplierLossPaise", input.supplierLossPaise],
    ["logisticsLossPaise", input.logisticsLossPaise],
    ["feeLossPaise", input.feeLossPaise],
    ["recoveryPaise", input.recoveryPaise],
  ] as const) {
    nonNegative(value, label);
  }

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

    const line = (name: string) =>
      `${input.orderId}:${name}`;
    const events: FinancialEventV2Input[] = [
      {
        provider: "SUPPLIER",
        accountScope: "SIM",
        externalEventId: input.supplierInvoiceRef,
        externalLineId: line("supplier-loss"),
        orderId: input.orderId,
        entryType: "SUPPLIER_PAYABLE",
        amountPaise: -input.supplierLossPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.supplierInvoiceRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: line("rto-logistics"),
        orderId: input.orderId,
        entryType: "LOGISTICS",
        amountPaise: -input.logisticsLossPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: line("rto-fee"),
        orderId: input.orderId,
        entryType: "MARKETPLACE_FEE",
        amountPaise: -input.feeLossPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "SUPPLIER",
        accountScope: "SIM",
        externalEventId: input.outcomeRef,
        externalLineId: line("rto-recovery"),
        orderId: input.orderId,
        entryType: "RETURN_RECOVERY",
        amountPaise: input.recoveryPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.outcomeRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "BANK",
        accountScope: "SIM",
        externalEventId: input.bankEvidenceRef,
        externalLineId: line("rto-cash"),
        orderId: input.orderId,
        entryType: "SETTLEMENT",
        amountPaise: input.actualNetCashPaise,
        economicEffect: false,
        cashEffect: true,
        provisional: false,
        sourceRef: input.bankEvidenceRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
    ];

    for (const event of events) {
      recordFinancialEventV2(database, event);
    }

    recordOutcomeReconciliation(database, {
      orderId: input.orderId,
      outcomeType: "RTO",
      outcomeRef: input.outcomeRef,
      marketplaceStatementRef: input.marketplaceStatementRef,
      supplierInvoiceRef: input.supplierInvoiceRef,
      bankEvidenceRef: input.bankEvidenceRef,
      expectedNetCashPaise: input.expectedNetCashPaise,
      actualNetCashPaise: input.actualNetCashPaise,
      reconciledAt: input.reconciledAt,
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
  readonly originalCustomerRevenuePaise: number;
  readonly originalMarketplaceFeePaise: number;
  readonly originalOutboundLogisticsPaise: number;
  readonly originalSupplierPayablePaise: number;
  readonly originalPackingPaise: number;
  readonly refundPaise: number;
  readonly residualFeeLossPaise: number;
  readonly returnLogisticsPaise: number;
  readonly marketplaceStatementRef: string;
  readonly supplierInvoiceRef: string;
  readonly bankEvidenceRef: string;
  readonly expectedNetCashPaise: number;
  readonly actualNetCashPaise: number;
  readonly reconciledAt: string;
}

export function reconcileClosedReturn(
  database: DatabaseSync,
  input: ReturnReconciliationInput,
): bigint {
  for (const [label, value] of [
    ["originalCustomerRevenuePaise", input.originalCustomerRevenuePaise],
    ["originalMarketplaceFeePaise", input.originalMarketplaceFeePaise],
    ["originalOutboundLogisticsPaise", input.originalOutboundLogisticsPaise],
    ["originalSupplierPayablePaise", input.originalSupplierPayablePaise],
    ["originalPackingPaise", input.originalPackingPaise],
    ["refundPaise", input.refundPaise],
    ["residualFeeLossPaise", input.residualFeeLossPaise],
    ["returnLogisticsPaise", input.returnLogisticsPaise],
  ] as const) {
    nonNegative(value, label);
  }

  const version = orderVersion(
    database,
    input.orderId,
    "RETURN_OPEN",
  );

  const returnRow = database
    .prepare(
      `
        SELECT
          state,
          recovery_paise,
          refund_paise,
          receipt_evidence_ref,
          recovery_evidence_ref
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
        receipt_evidence_ref: string | null;
        recovery_evidence_ref: string | null;
      }
    | undefined;

  if (
    returnRow === undefined ||
    returnRow.state !== "CLOSED" ||
    returnRow.receipt_evidence_ref === null
  ) {
    throw new Error(
      "Return must be physically received and CLOSED before reconciliation.",
    );
  }

  if (
    returnRow.refund_paise !== BigInt(input.refundPaise) ||
    (returnRow.recovery_paise > 0n &&
      returnRow.recovery_evidence_ref === null)
  ) {
    throw new Error(
      "Return refund/recovery evidence does not match reconciliation.",
    );
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

    const line = (name: string) =>
      `${input.orderId}:${name}`;
    const base: FinancialEventV2Input[] = [
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: line("revenue"),
        orderId: input.orderId,
        entryType: "CUSTOMER_REVENUE",
        amountPaise: input.originalCustomerRevenuePaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: line("original-fee"),
        orderId: input.orderId,
        entryType: "MARKETPLACE_FEE",
        amountPaise: -input.originalMarketplaceFeePaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: line("outbound-logistics"),
        orderId: input.orderId,
        entryType: "LOGISTICS",
        amountPaise: -input.originalOutboundLogisticsPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "SUPPLIER",
        accountScope: "SIM",
        externalEventId: input.supplierInvoiceRef,
        externalLineId: line("supplier"),
        orderId: input.orderId,
        entryType: "SUPPLIER_PAYABLE",
        amountPaise: -input.originalSupplierPayablePaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.supplierInvoiceRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "INTERNAL",
        accountScope: "LOCAL",
        externalEventId: line("costs"),
        externalLineId: "packing",
        orderId: input.orderId,
        entryType: "PACKING",
        amountPaise: -input.originalPackingPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: "local-packing",
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.refundEventId,
        externalLineId: line("refund"),
        orderId: input.orderId,
        entryType: "REFUND",
        amountPaise: -input.refundPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.refundEventId,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceReturnId,
        externalLineId: line("return-fee"),
        orderId: input.orderId,
        entryType: "MARKETPLACE_FEE",
        amountPaise: -input.residualFeeLossPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceReturnId,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceReturnId,
        externalLineId: line("return-logistics"),
        orderId: input.orderId,
        entryType: "LOGISTICS",
        amountPaise: -input.returnLogisticsPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceReturnId,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "SUPPLIER",
        accountScope: "SIM",
        externalEventId:
          returnRow.recovery_evidence_ref ??
          input.marketplaceReturnId,
        externalLineId: line("return-recovery"),
        orderId: input.orderId,
        entryType: "RETURN_RECOVERY",
        amountPaise: Number(returnRow.recovery_paise),
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef:
          returnRow.recovery_evidence_ref ??
          input.marketplaceReturnId,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
      {
        provider: "BANK",
        accountScope: "SIM",
        externalEventId: input.bankEvidenceRef,
        externalLineId: line("return-net-cash"),
        orderId: input.orderId,
        entryType: "SETTLEMENT",
        amountPaise: input.actualNetCashPaise,
        economicEffect: false,
        cashEffect: true,
        provisional: false,
        sourceRef: input.bankEvidenceRef,
        eventAt: input.reconciledAt,
        createdAt: input.reconciledAt,
      },
    ];

    for (const event of base) {
      recordFinancialEventV2(database, event);
    }

    recordOutcomeReconciliation(database, {
      orderId: input.orderId,
      outcomeType: "RETURN",
      outcomeRef: input.marketplaceReturnId,
      marketplaceStatementRef: input.marketplaceStatementRef,
      supplierInvoiceRef: input.supplierInvoiceRef,
      bankEvidenceRef: input.bankEvidenceRef,
      expectedNetCashPaise: input.expectedNetCashPaise,
      actualNetCashPaise: input.actualNetCashPaise,
      reconciledAt: input.reconciledAt,
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
