import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { confirmPack } from "./service.ts";
import {
  recordPurchaseIntent,
  submitPurchaseOnce,
} from "../procurement/service.ts";
import {
  SimulatedSupplierPurchaseAdapter,
} from "../supplier/simulated-purchase.ts";
import {
  authorizeSingleOrder,
  ingestSingleOrder,
  seedSingleSkuFixture,
} from "../test/commerce-fixture.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function confirmedOrder(
  database: ReturnType<typeof openDatabase>,
  provider: SimulatedSupplierPurchaseAdapter,
): string {
  const fixture = seedSingleSkuFixture(database);
  const orderId = ingestSingleOrder(database, "PACK");
  authorizeSingleOrder(
    database,
    orderId,
    fixture.sourceOfferId,
  );
  const poId = recordPurchaseIntent(database, {
    orderId,
    destinationKey: "DEST-PACK",
    authorizationExpiresAt: "2026-10-07T00:18:00.000Z",
    createdAt: "2026-10-07T00:13:00.000Z",
  });
  submitPurchaseOnce(
    database,
    poId,
    provider,
    "2026-10-07T00:13:30.000Z",
  );
  return orderId;
}

test("pack confirmation requires the exact ordered barcode", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const orderId = confirmedOrder(database, provider);

    assert.throws(
      () =>
        confirmPack(
          database,
          orderId,
          "4006381333948",
          "SCAN-WRONG",
          "LABEL-1",
          "CARRIER",
          "TRACK-1",
          "2026-10-07T00:20:00.000Z",
        ),
      /Scanned barcode does not match/,
    );

    const order = database
      .prepare("SELECT state FROM orders WHERE id = ?")
      .get(orderId) as { state: string };
    const shipmentCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM shipments WHERE order_id = ?",
      )
      .get(orderId) as { count: bigint };

    assert.equal(order.state, "PO_CONFIRMED");
    assert.equal(shipmentCount.count, 0n);
  } finally {
    provider.close();
    database.close();
  }
});

test("mapping invalidation after purchase blocks pack confirmation", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const orderId = confirmedOrder(database, provider);

    database
      .prepare(
        `
          UPDATE packaged_trade_units
          SET
            mapping_status = 'INVALIDATED',
            invalidation_reason = 'PACK_STAGE_CONFLICT',
            updated_at = '2026-10-07T00:19:00.000Z'
          WHERE id = 'trade-1'
        `,
      )
      .run();

    assert.throws(
      () =>
        confirmPack(
          database,
          orderId,
          "4006381333931",
          "SCAN-1",
          "LABEL-1",
          "CARRIER",
          "TRACK-1",
          "2026-10-07T00:20:00.000Z",
        ),
      /invalidated immutable identity evidence/,
    );

    const order = database
      .prepare("SELECT state FROM orders WHERE id = ?")
      .get(orderId) as { state: string };
    assert.equal(order.state, "PO_CONFIRMED");
  } finally {
    provider.close();
    database.close();
  }
});
