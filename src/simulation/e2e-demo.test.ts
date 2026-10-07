import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { runLocalEndToEndDemo } from "./e2e-demo.ts";

test("runs the complete local commerce happy path to matured profit", () => {
  const database = openDatabase(":memory:", {
    appliedAt: "2026-10-07T00:00:00.000Z",
  });

  try {
    const summary = runLocalEndToEndDemo(database);

    assert.equal(summary.finalOrderState, "MATURED");
    assert.equal(summary.opportunityState, "LIST");
    assert.equal(summary.listingState, "PAUSED");
    assert.equal(summary.listingQuantity, 0n);
    assert.equal(summary.purchaseState, "CONFIRMED");
    assert.equal(summary.shipmentState, "DELIVERED");
    assert.equal(summary.recognizedProfitPaise, 21_503n);
    assert.ok(summary.auditEventCount >= 8n);

    const orderCount = database
      .prepare("SELECT COUNT(*) AS count FROM orders")
      .get() as { count: bigint };
    const poCount = database
      .prepare("SELECT COUNT(*) AS count FROM purchase_orders")
      .get() as { count: bigint };
    const purchaseAuthority = database
      .prepare(
        `
          SELECT
            a.consumed_at,
            ai.state AS intent_state
          FROM purchase_orders po
          JOIN purchase_authorizations a
            ON a.id = po.authorization_id
          JOIN action_intents ai
            ON ai.subject_id = po.order_id
            AND ai.payload_hash = po.payload_hash
          WHERE po.id IN (SELECT id FROM purchase_orders LIMIT 1)
        `,
      )
      .get() as {
      consumed_at: string | null;
      intent_state: string;
    };
    const pool = database
      .prepare(
        `
          SELECT consumed_units
          FROM supply_pools
          WHERE supplier_id = 'supplier-1'
            AND supplier_sku = 'ACME-SKU-001'
        `,
      )
      .get() as { consumed_units: bigint };
    const engineProviderRows = database
      .prepare(
        "SELECT COUNT(*) AS count FROM simulated_supplier_orders",
      )
      .get() as { count: bigint };
    const activeReservations = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM reservations
          WHERE status = 'ACTIVE'
        `,
      )
      .get() as { count: bigint };

    assert.equal(orderCount.count, 1n);
    assert.equal(poCount.count, 1n);
    assert.ok(purchaseAuthority.consumed_at !== null);
    assert.equal(purchaseAuthority.intent_state, "SUCCEEDED");
    assert.equal(pool.consumed_units, 1n);
    assert.equal(engineProviderRows.count, 0n);
    assert.equal(activeReservations.count, 0n);
  } finally {
    database.close();
  }
});
