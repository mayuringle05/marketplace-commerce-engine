import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";
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

export interface FinancialEventV2Input {
  readonly provider: string;
  readonly accountScope: string;
  readonly externalEventId: string;
  readonly externalLineId: string;
  readonly orderId: string | null;
  readonly entryType: LedgerEntryType;
  readonly amountPaise: number;
  readonly economicEffect: boolean;
  readonly cashEffect: boolean;
  readonly provisional: boolean;
  readonly sourceRef: string;
  readonly eventAt: string;
  readonly createdAt: string;
}

function requiredText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
}

export function recordFinancialEventV2(
  database: DatabaseSync,
  input: FinancialEventV2Input,
): string {
  if (!Number.isSafeInteger(input.amountPaise)) {
    throw new Error("Financial event amount must be a safe integer.");
  }

  for (const [label, value] of [
    ["provider", input.provider],
    ["accountScope", input.accountScope],
    ["externalEventId", input.externalEventId],
    ["externalLineId", input.externalLineId],
    ["sourceRef", input.sourceRef],
  ] as const) {
    requiredText(value, label);
  }

  const payload = {
    orderId: input.orderId,
    entryType: input.entryType,
    amountPaise: input.amountPaise,
    economicEffect: input.economicEffect,
    cashEffect: input.cashEffect,
    provisional: input.provisional,
    sourceRef: input.sourceRef,
    eventAt: input.eventAt,
  };
  const payloadHash = sha256Hex(canonicalJson(payload));
  const id = deterministicId(
    "finance",
    input.provider,
    input.accountScope,
    input.externalEventId,
    input.externalLineId,
  );

  const existing = database
    .prepare(
      `
        SELECT payload_hash
        FROM financial_events_v2
        WHERE provider = ?
          AND account_scope = ?
          AND external_event_id = ?
          AND external_line_id = ?
      `,
    )
    .get(
      input.provider,
      input.accountScope,
      input.externalEventId,
      input.externalLineId,
    ) as { payload_hash: string } | undefined;

  if (existing !== undefined) {
    if (existing.payload_hash !== payloadHash) {
      throw new Error(
        "Conflicting replay for financial source event.",
      );
    }
    return id;
  }

  database
    .prepare(
      `
        INSERT INTO financial_events_v2 (
          id,
          provider,
          account_scope,
          external_event_id,
          external_line_id,
          order_id,
          entry_type,
          amount_paise,
          economic_effect,
          cash_effect,
          provisional,
          source_ref,
          event_at,
          payload_hash,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.provider,
      input.accountScope,
      input.externalEventId,
      input.externalLineId,
      input.orderId,
      input.entryType,
      input.amountPaise,
      input.economicEffect ? 1 : 0,
      input.cashEffect ? 1 : 0,
      input.provisional ? 1 : 0,
      input.sourceRef,
      input.eventAt,
      payloadHash,
      input.createdAt,
    );

  return id;
}

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
  return recordFinancialEventV2(database, {
    provider: "LEGACY",
    accountScope: "LEGACY",
    externalEventId: input.externalEventId,
    externalLineId:
      `${input.orderId ?? "none"}:${input.entryType}`,
    orderId: input.orderId,
    entryType: input.entryType,
    amountPaise: input.amountPaise,
    economicEffect:
      input.recognized &&
      input.entryType !== "SETTLEMENT" &&
      input.entryType !== "TAX_OUTPUT" &&
      input.entryType !== "TAX_INPUT_CREDIT" &&
      input.entryType !== "WITHHOLDING_ASSET",
    cashEffect: input.entryType === "SETTLEMENT",
    provisional: input.provisional,
    sourceRef: input.sourceRef,
    eventAt: input.eventAt,
    createdAt: input.createdAt,
  });
}

export function recognizedOrderProfitPaise(
  database: DatabaseSync,
  orderId: string,
): bigint {
  const row = database
    .prepare(
      `
        SELECT COALESCE(SUM(amount_paise), 0) AS amount
        FROM financial_events_v2
        WHERE order_id = ?
          AND economic_effect = 1
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
  readonly expectedSettlementCashPaise: number;
  readonly settlementCashPaise: number;
  readonly marketplaceStatementRef: string;
  readonly supplierInvoiceRef: string;
  readonly bankEvidenceRef: string;
  readonly settledAt: string;
}

function assertNonNegativeMoney(
  value: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function existingReconciliationMatches(
  database: DatabaseSync,
  input: KeptSettlementInput,
  maturityEligibleAt: string,
): boolean {
  const row = database
    .prepare(
      `
        SELECT
          marketplace_statement_ref,
          supplier_invoice_ref,
          bank_evidence_ref,
          expected_settlement_paise,
          actual_settlement_paise,
          maturity_eligible_at,
          reconciled_at
        FROM financial_reconciliations
        WHERE order_id = ?
      `,
    )
    .get(input.orderId) as
    | {
        marketplace_statement_ref: string;
        supplier_invoice_ref: string;
        bank_evidence_ref: string;
        expected_settlement_paise: bigint;
        actual_settlement_paise: bigint;
        maturity_eligible_at: string;
        reconciled_at: string;
      }
    | undefined;

  return (
    row !== undefined &&
    row.marketplace_statement_ref === input.marketplaceStatementRef &&
    row.supplier_invoice_ref === input.supplierInvoiceRef &&
    row.bank_evidence_ref === input.bankEvidenceRef &&
    row.expected_settlement_paise ===
      BigInt(input.expectedSettlementCashPaise) &&
    row.actual_settlement_paise ===
      BigInt(input.settlementCashPaise) &&
    row.maturity_eligible_at === maturityEligibleAt &&
    row.reconciled_at === input.settledAt
  );
}

export function reconcileDeliveredKeptOrder(
  database: DatabaseSync,
  input: KeptSettlementInput,
): bigint {
  for (const [label, value] of [
    ["customerRevenuePaise", input.customerRevenuePaise],
    ["marketplaceFeePaise", input.marketplaceFeePaise],
    ["logisticsPaise", input.logisticsPaise],
    ["supplierPayablePaise", input.supplierPayablePaise],
    ["packingPaise", input.packingPaise],
    ["overheadPaise", input.overheadPaise],
    [
      "expectedSettlementCashPaise",
      input.expectedSettlementCashPaise,
    ],
    ["settlementCashPaise", input.settlementCashPaise],
  ] as const) {
    assertNonNegativeMoney(value, label);
  }

  if (
    input.customerRevenuePaise === 0 ||
    input.expectedSettlementCashPaise === 0 ||
    input.settlementCashPaise !==
      input.expectedSettlementCashPaise
  ) {
    throw new Error(
      "Maturity requires non-zero customer economics and exact bank settlement reconciliation.",
    );
  }

  for (const [label, value] of [
    ["marketplaceStatementRef", input.marketplaceStatementRef],
    ["supplierInvoiceRef", input.supplierInvoiceRef],
    ["bankEvidenceRef", input.bankEvidenceRef],
  ] as const) {
    requiredText(value, label);
  }

  const settledMs = assertCanonicalUtcTimestamp(
    input.settledAt,
    "settledAt",
  );

  const order = database
    .prepare(
      `
        SELECT state, version, maturity_eligible_at
        FROM orders
        WHERE id = ?
      `,
    )
    .get(input.orderId) as
    | {
        state: string;
        version: bigint;
        maturity_eligible_at: string | null;
      }
    | undefined;

  if (order === undefined || order.maturity_eligible_at === null) {
    throw new Error("Order has no persisted maturity boundary.");
  }

  const maturityMs = assertCanonicalUtcTimestamp(
    order.maturity_eligible_at,
    "maturityEligibleAt",
  );
  if (settledMs < maturityMs) {
    throw new Error(
      "Delivered order cannot mature before the persisted return/maturity boundary.",
    );
  }

  if (order.state === "MATURED") {
    if (
      !existingReconciliationMatches(
        database,
        input,
        order.maturity_eligible_at,
      )
    ) {
      throw new Error("Conflicting replay for matured reconciliation.");
    }
    return recognizedOrderProfitPaise(
      database,
      input.orderId,
    );
  }

  if (order.state !== "DELIVERED") {
    throw new Error("Kept reconciliation requires DELIVERED order.");
  }

  const open = database
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM exceptions
            WHERE order_id = ? AND state = 'OPEN') +
          (SELECT COUNT(*) FROM returns
            WHERE order_id = ? AND state != 'CLOSED')
          AS count
      `,
    )
    .get(input.orderId, input.orderId) as { count: bigint };
  if (open.count !== 0n) {
    throw new Error(
      "Order cannot mature with unresolved exceptions or returns.",
    );
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

    const orderLine = (name: string) =>
      `${input.orderId}:${name}`;

    const events: FinancialEventV2Input[] = [
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: orderLine("revenue"),
        orderId: input.orderId,
        entryType: "CUSTOMER_REVENUE",
        amountPaise: input.customerRevenuePaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: orderLine("fee"),
        orderId: input.orderId,
        entryType: "MARKETPLACE_FEE",
        amountPaise: -input.marketplaceFeePaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
      {
        provider: "MARKETPLACE",
        accountScope: "SIM",
        externalEventId: input.marketplaceStatementRef,
        externalLineId: orderLine("logistics"),
        orderId: input.orderId,
        entryType: "LOGISTICS",
        amountPaise: -input.logisticsPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.marketplaceStatementRef,
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
      {
        provider: "SUPPLIER",
        accountScope: "SIM",
        externalEventId: input.supplierInvoiceRef,
        externalLineId: orderLine("supplier"),
        orderId: input.orderId,
        entryType: "SUPPLIER_PAYABLE",
        amountPaise: -input.supplierPayablePaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: input.supplierInvoiceRef,
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
      {
        provider: "INTERNAL",
        accountScope: "LOCAL",
        externalEventId: orderLine("costs"),
        externalLineId: "packing",
        orderId: input.orderId,
        entryType: "PACKING",
        amountPaise: -input.packingPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: "local-packing",
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
      {
        provider: "INTERNAL",
        accountScope: "LOCAL",
        externalEventId: orderLine("costs"),
        externalLineId: "overhead",
        orderId: input.orderId,
        entryType: "ADJUSTMENT",
        amountPaise: -input.overheadPaise,
        economicEffect: true,
        cashEffect: false,
        provisional: false,
        sourceRef: "allocated-overhead",
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
      {
        provider: "BANK",
        accountScope: "SIM",
        externalEventId: input.bankEvidenceRef,
        externalLineId: orderLine("settlement"),
        orderId: input.orderId,
        entryType: "SETTLEMENT",
        amountPaise: input.settlementCashPaise,
        economicEffect: false,
        cashEffect: true,
        provisional: false,
        sourceRef: input.bankEvidenceRef,
        eventAt: input.settledAt,
        createdAt: input.settledAt,
      },
    ];

    for (const event of events) {
      recordFinancialEventV2(database, event);
    }

    database
      .prepare(
        `
          INSERT INTO financial_reconciliations (
            order_id,
            marketplace_statement_ref,
            supplier_invoice_ref,
            bank_evidence_ref,
            expected_settlement_paise,
            actual_settlement_paise,
            maturity_eligible_at,
            reconciled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.orderId,
        input.marketplaceStatementRef,
        input.supplierInvoiceRef,
        input.bankEvidenceRef,
        input.expectedSettlementCashPaise,
        input.settlementCashPaise,
        order.maturity_eligible_at,
        input.settledAt,
      );

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

    consumeReservation(
      database,
      input.orderId,
      input.settledAt,
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return recognizedOrderProfitPaise(database, input.orderId);
}
