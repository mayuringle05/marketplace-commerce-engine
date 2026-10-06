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
    assert.equal(summary.listingState, "ACTIVE");
    assert.equal(summary.listingQuantity, 1n);
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
    const supplierOrderCount = database
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
    assert.equal(supplierOrderCount.count, 1n);
    assert.equal(activeReservations.count, 0n);
  } finally {
    database.close();
  }
});
