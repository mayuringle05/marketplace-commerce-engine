import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  recognizedOrderProfitPaise,
  recordFinancialEvent,
} from "./ledger.ts";
import {
  reconcileClosedReturn,
  reconcileRtoOrder,
} from "./outcomes.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function insertOrder(
  database: ReturnType<typeof openDatabase>,
  id: string,
  state: string,
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
          immutable_economics_json
        ) VALUES (?, 'SIM', ?, ?, 1, ?, ?, '{}')
      `,
    )
    .run(id, `REMOTE-${id}`, state, T0, T0);
}

test("RTO reconciliation matures actual loss without hypothetical reserves", () => {
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
      sourceRef: "RTO-STATEMENT-1",
      reconciledAt: "2026-10-20T00:00:00.000Z",
    });

    assert.equal(profit, -10_500n);

    const row = database
      .prepare("SELECT state FROM orders WHERE id = 'order-rto'")
      .get() as { state: string };
    assert.equal(row.state, "MATURED");
  } finally {
    database.close();
  }
});

test("closed return reconciles refund once and books only realized recovery", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-return", "RETURN_OPEN");

    database
      .prepare(
        `
          INSERT INTO returns (
            id,
            order_id,
            marketplace_return_id,
            state,
            refund_paise,
            recovery_paise,
            grade,
            created_at,
            updated_at
          ) VALUES (
            'return-1',
            'order-return',
            'RET-REMOTE-1',
            'CLOSED',
            79_900,
            20_000,
            'B',
            ?,
            ?
          )
        `,
      )
      .run(T0, T0);

    const profit = reconcileClosedReturn(database, {
      orderId: "order-return",
      marketplaceReturnId: "RET-REMOTE-1",
      refundEventId: "REFUND-EVENT-1",
      refundPaise: 79_900,
      feeLossPaise: 1_500,
      returnLogisticsPaise: 4_500,
      sourceRef: "RETURN-STATEMENT-1",
      reconciledAt: "2026-10-20T00:00:00.000Z",
    });

    assert.equal(profit, -65_900n);

    const refundCount = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM ledger_entries
          WHERE order_id = 'order-return'
            AND entry_type = 'REFUND'
        `,
      )
      .get() as { count: bigint };

    assert.equal(refundCount.count, 1n);
  } finally {
    database.close();
  }
});

test("duplicate external financial event cannot double-count profit", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    insertOrder(database, "order-ledger", "MATURED");

    const event = {
      orderId: "order-ledger",
      externalEventId: "FEE-EVENT-1",
      entryType: "MARKETPLACE_FEE" as const,
      amountPaise: -1_000,
      recognized: true,
      provisional: false,
      sourceRef: "statement",
      eventAt: T0,
      createdAt: T0,
    };

    recordFinancialEvent(database, event);
    recordFinancialEvent(database, event);

    assert.equal(
      recognizedOrderProfitPaise(database, "order-ledger"),
      -1_000n,
    );

    const row = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM ledger_entries
          WHERE external_event_id = 'FEE-EVENT-1'
            AND entry_type = 'MARKETPLACE_FEE'
        `,
      )
      .get() as { count: bigint };

    assert.equal(row.count, 1n);
  } finally {
    database.close();
  }
});
