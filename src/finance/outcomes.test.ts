import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  reconcileDeliveredKeptOrder,
  recognizedOrderProfitPaise,
  recordFinancialEventV2,
} from "./ledger.ts";
import {
  reconcileClosedReturn,
  reconcileRtoOrder,
} from "./outcomes.ts";
import {
  gradeAndCloseReturn,
  markReturnReceived,
  openReturn,
} from "../returns/service.ts";

const T0 = "2026-10-07T00:00:00.000Z";
const MATURITY = "2026-10-20T00:00:00.000Z";

function insertOrder(
  database: ReturnType<typeof openDatabase>,
  id: string,
  state: string,
  maturityEligibleAt: string | null = null,
): void {
  database
    .prepare(
      `
        INSERT INTO orders (
          id,
          marketplace,
          marketplace_order_id,
          state,
          version,
          received_at,
          updated_at,
          immutable_economics_json,
          maturity_eligible_at
        ) VALUES (?, 'SIM', ?, ?, 1, ?, ?, '{}', ?)
      `,
    )
    .run(
      id,
      `REMOTE-${id}`,
      state,
      T0,
      T0,
      maturityEligibleAt,
    );
}

function keptInput(orderId: string, bankRef: string) {
  return {
    orderId,
    customerRevenuePaise: 67_712,
    marketplaceFeePaise: 10_000,
    logisticsPaise: 2_500,
    supplierPayablePaise: 30_509,
    packingPaise: 2_000,
    overheadPaise: 1_200,
    expectedSettlementCashPaise: 64_750,
    settlementCashPaise: 64_750,
    marketplaceStatementRef: "SHARED-STATEMENT-1",
    supplierInvoiceRef: `INVOICE-${orderId}`,
    bankEvidenceRef: bankRef,
    settledAt: MATURITY,
  } as const;
}

test("two orders can share a marketplace statement without losing financial lines", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-a", "DELIVERED", MATURITY);
    insertOrder(database, "order-b", "DELIVERED", MATURITY);

    const profitA = reconcileDeliveredKeptOrder(
      database,
      keptInput("order-a", "BANK-A"),
    );
    const profitB = reconcileDeliveredKeptOrder(
      database,
      keptInput("order-b", "BANK-B"),
    );

    assert.equal(profitA, 21_503n);
    assert.equal(profitB, 21_503n);

    const rows = database
      .prepare(
        `
          SELECT order_id, COUNT(*) AS count
          FROM financial_events_v2
          WHERE external_event_id = 'SHARED-STATEMENT-1'
          GROUP BY order_id
          ORDER BY order_id
        `,
      )
      .all() as unknown as Array<{
      order_id: string;
      count: bigint;
    }>;

    assert.deepEqual(rows, [
      { order_id: "order-a", count: 3n },
      { order_id: "order-b", count: 3n },
    ]);
  } finally {
    database.close();
  }
});

test("changed financial source replay is rejected instead of silently ignored", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-ledger", "MATURED");

    const base = {
      provider: "MARKETPLACE",
      accountScope: "SIM",
      externalEventId: "FEE-EVENT-1",
      externalLineId: "line-1",
      orderId: "order-ledger",
      entryType: "MARKETPLACE_FEE" as const,
      amountPaise: -1_000,
      economicEffect: true,
      cashEffect: false,
      provisional: false,
      sourceRef: "statement",
      eventAt: T0,
      createdAt: T0,
    };

    recordFinancialEventV2(database, base);
    recordFinancialEventV2(database, base);

    assert.throws(
      () =>
        recordFinancialEventV2(database, {
          ...base,
          amountPaise: -9_000,
        }),
      /Conflicting replay for financial source event/,
    );

    assert.equal(
      recognizedOrderProfitPaise(database, "order-ledger"),
      -1_000n,
    );
  } finally {
    database.close();
  }
});

test("zero, partial, or negative-cost settlement cannot falsely mature profit", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-zero", "DELIVERED", MATURITY);
    assert.throws(
      () =>
        reconcileDeliveredKeptOrder(database, {
          ...keptInput("order-zero", "BANK-ZERO"),
          expectedSettlementCashPaise: 0,
          settlementCashPaise: 0,
        }),
      /requires non-zero customer economics and exact bank settlement/,
    );

    insertOrder(database, "order-partial", "DELIVERED", MATURITY);
    assert.throws(
      () =>
        reconcileDeliveredKeptOrder(database, {
          ...keptInput("order-partial", "BANK-PARTIAL"),
          settlementCashPaise: 60_000,
        }),
      /exact bank settlement reconciliation/,
    );

    insertOrder(database, "order-negative", "DELIVERED", MATURITY);
    assert.throws(
      () =>
        reconcileDeliveredKeptOrder(database, {
          ...keptInput("order-negative", "BANK-NEG"),
          marketplaceFeePaise: -10_000,
        }),
      /marketplaceFeePaise must be a non-negative integer/,
    );

    for (const id of [
      "order-zero",
      "order-partial",
      "order-negative",
    ]) {
      const state = database
        .prepare("SELECT state FROM orders WHERE id = ?")
        .get(id) as { state: string };
      assert.equal(state.state, "DELIVERED");
    }
  } finally {
    database.close();
  }
});

test("persisted maturity boundary blocks early settlement", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-early", "DELIVERED", MATURITY);

    assert.throws(
      () =>
        reconcileDeliveredKeptOrder(database, {
          ...keptInput("order-early", "BANK-EARLY"),
          settledAt: "2026-10-19T23:59:59.999Z",
        }),
      /persisted return\/maturity boundary/,
    );

    const state = database
      .prepare(
        "SELECT state FROM orders WHERE id = 'order-early'",
      )
      .get() as { state: string };
    assert.equal(state.state, "DELIVERED");
  } finally {
    database.close();
  }
});

test("RTO requires document-backed exact bank reconciliation", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-rto", "RTO");

    const profit = reconcileRtoOrder(database, {
      orderId: "order-rto",
      supplierLossPaise: 8_000,
      logisticsLossPaise: 4_000,
      feeLossPaise: 1_000,
      recoveryPaise: 2_500,
      outcomeRef: "RTO-1",
      marketplaceStatementRef: "RTO-STATEMENT-1",
      supplierInvoiceRef: "RTO-INVOICE-1",
      bankEvidenceRef: "RTO-BANK-1",
      expectedNetCashPaise: -10_500,
      actualNetCashPaise: -10_500,
      reconciledAt: MATURITY,
    });

    assert.equal(profit, -10_500n);

    const state = database
      .prepare(
        "SELECT state FROM orders WHERE id = 'order-rto'",
      )
      .get() as { state: string };
    assert.equal(state.state, "MATURED");
  } finally {
    database.close();
  }
});

test("return P&L includes original transaction and requires receipt plus realized recovery evidence", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-return", "DELIVERED", MATURITY);

    const returnId = openReturn(
      database,
      "order-return",
      "RETURN-1",
      79_900,
      "2026-10-10T00:00:00.000Z",
    );

    assert.throws(
      () =>
        gradeAndCloseReturn(
          database,
          returnId,
          "B",
          20_000,
          "RECOVERY-1",
          "2026-10-11T00:00:00.000Z",
        ),
      /physically received/,
    );

    markReturnReceived(
      database,
      returnId,
      "RETURN-RECEIPT-1",
      "2026-10-11T00:00:00.000Z",
    );

    assert.throws(
      () =>
        gradeAndCloseReturn(
          database,
          returnId,
          "B",
          20_000,
          null,
          "2026-10-11T01:00:00.000Z",
        ),
      /Positive realized recovery requires recovery evidence/,
    );

    gradeAndCloseReturn(
      database,
      returnId,
      "B",
      20_000,
      "RECOVERY-1",
      "2026-10-11T01:00:00.000Z",
    );

    const profit = reconcileClosedReturn(database, {
      orderId: "order-return",
      marketplaceReturnId: "RETURN-1",
      refundEventId: "REFUND-1",
      originalCustomerRevenuePaise: 79_900,
      originalMarketplaceFeePaise: 10_000,
      originalOutboundLogisticsPaise: 2_500,
      originalSupplierPayablePaise: 30_509,
      originalPackingPaise: 2_000,
      refundPaise: 79_900,
      residualFeeLossPaise: 1_500,
      returnLogisticsPaise: 4_500,
      marketplaceStatementRef: "RETURN-STATEMENT-1",
      supplierInvoiceRef: "RETURN-INVOICE-1",
      bankEvidenceRef: "RETURN-BANK-1",
      expectedNetCashPaise: -31_009,
      actualNetCashPaise: -31_009,
      reconciledAt: MATURITY,
    });

    assert.equal(profit, -31_009n);

    const types = database
      .prepare(
        `
          SELECT entry_type
          FROM financial_events_v2
          WHERE order_id = 'order-return'
            AND economic_effect = 1
          ORDER BY entry_type
        `,
      )
      .all() as unknown as Array<{ entry_type: string }>;

    assert.ok(
      types.some((row) => row.entry_type === "CUSTOMER_REVENUE"),
    );
    assert.ok(
      types.some((row) => row.entry_type === "SUPPLIER_PAYABLE"),
    );
    assert.ok(types.some((row) => row.entry_type === "PACKING"));
    assert.ok(types.some((row) => row.entry_type === "REFUND"));
    assert.ok(
      types.some((row) => row.entry_type === "RETURN_RECOVERY"),
    );
  } finally {
    database.close();
  }
});

test("late return can reopen a previously matured order", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-late-return", "MATURED", MATURITY);

    openReturn(
      database,
      "order-late-return",
      "RETURN-LATE",
      10_000,
      "2026-10-25T00:00:00.000Z",
    );

    const state = database
      .prepare(
        "SELECT state FROM orders WHERE id = 'order-late-return'",
      )
      .get() as { state: string };
    assert.equal(state.state, "RETURN_OPEN");
  } finally {
    database.close();
  }
});
