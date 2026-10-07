import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  recordPurchaseIntent,
  reconcilePurchase,
  submitPurchaseOnce,
} from "./service.ts";
import {
  SimulatedSupplierPurchaseAdapter,
} from "../supplier/simulated-purchase.ts";
import { parseSupplierFeedJson } from "../supplier/feed.ts";
import { importSupplierFeed } from "../supplier/importer.ts";
import { readSupplyPoolCapacity } from "../supplier/pools.ts";
import {
  authorizeSingleOrder,
  ingestSingleOrder,
  seedSingleSkuFixture,
} from "../test/commerce-fixture.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function authorizedOrder(
  database: ReturnType<typeof openDatabase>,
): {
  readonly orderId: string;
  readonly sourceOfferId: string;
} {
  const fixture = seedSingleSkuFixture(database);
  const orderId = ingestSingleOrder(database);
  authorizeSingleOrder(
    database,
    orderId,
    fixture.sourceOfferId,
  );
  return {
    orderId,
    sourceOfferId: fixture.sourceOfferId,
  };
}

function createIntent(
  database: ReturnType<typeof openDatabase>,
  orderId: string,
  expiresAt = "2026-10-07T00:18:00.000Z",
): string {
  return recordPurchaseIntent(database, {
    orderId,
    destinationKey: "DEST-1",
    authorizationExpiresAt: expiresAt,
    createdAt: "2026-10-07T00:13:00.000Z",
  });
}

test("purchase intent is bound to exact order reservation supplier SKU route mapping and destination", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const { orderId } = authorizedOrder(database);
    const poId = createIntent(database, orderId);

    const row = database
      .prepare(
        `
          SELECT
            a.quantity,
            a.maximum_amount_paise,
            a.destination_key,
            a.supplier_id,
            a.supplier_sku,
            a.fulfilment_route_id,
            a.trade_unit_id,
            a.mapping_version,
            a.reservation_id,
            po.authorized_amount_paise,
            po.quantity
          FROM purchase_orders po
          JOIN purchase_authorizations a
            ON a.id = po.authorization_id
          WHERE po.id = ?
        `,
      )
      .get(poId) as {
      quantity: bigint;
      maximum_amount_paise: bigint;
      destination_key: string;
      supplier_id: string;
      supplier_sku: string;
      fulfilment_route_id: string;
      trade_unit_id: string;
      mapping_version: bigint;
      reservation_id: string;
      authorized_amount_paise: bigint;
    };

    assert.equal(row.quantity, 1n);
    assert.equal(row.maximum_amount_paise, 35_000n);
    assert.equal(row.authorized_amount_paise, 35_000n);
    assert.equal(row.destination_key, "DEST-1");
    assert.equal(row.supplier_id, "supplier-1");
    assert.equal(row.supplier_sku, "SKU-1");
    assert.equal(row.fulfilment_route_id, "route-1");
    assert.equal(row.trade_unit_id, "trade-1");
    assert.equal(row.mapping_version, 1n);
    assert.ok(row.reservation_id.length > 0);
  } finally {
    database.close();
  }
});

test("authorization expiry is exclusive and releases proven-unspent reservation", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const { orderId } = authorizedOrder(database);
    const poId = createIntent(
      database,
      orderId,
      "2026-10-07T00:13:30.000Z",
    );

    submitPurchaseOnce(
      database,
      poId,
      provider,
      "2026-10-07T00:13:30.000Z",
    );

    const order = database
      .prepare("SELECT state FROM orders WHERE id = ?")
      .get(orderId) as { state: string };
    const po = database
      .prepare("SELECT state FROM purchase_orders WHERE id = ?")
      .get(poId) as { state: string };
    const reservation = database
      .prepare(
        "SELECT status FROM reservations WHERE order_id = ?",
      )
      .get(orderId) as { status: string };
    const providerCount = provider.database
      .prepare(
        "SELECT COUNT(*) AS count FROM supplier_purchase_history",
      )
      .get() as { count: bigint };

    assert.equal(order.state, "SLA_BREACH");
    assert.equal(po.state, "REJECTED");
    assert.equal(reservation.status, "RELEASED");
    assert.equal(providerCount.count, 0n);
  } finally {
    provider.close();
    database.close();
  }
});

test("marketplace cancellation before provider call causes zero supplier submissions", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const { orderId } = authorizedOrder(database);
    const poId = createIntent(database, orderId);

    database
      .prepare(
        `
          UPDATE simulated_marketplace_orders
          SET status = 'CANCELLED',
              updated_at = '2026-10-07T00:13:15.000Z'
          WHERE marketplace_order_id = 'ORDER-1'
        `,
      )
      .run();

    submitPurchaseOnce(
      database,
      poId,
      provider,
      "2026-10-07T00:13:30.000Z",
    );

    const order = database
      .prepare("SELECT state FROM orders WHERE id = ?")
      .get(orderId) as { state: string };
    const reservation = database
      .prepare(
        "SELECT status FROM reservations WHERE order_id = ?",
      )
      .get(orderId) as { status: string };
    const providerCount = provider.database
      .prepare(
        "SELECT COUNT(*) AS count FROM supplier_purchase_history",
      )
      .get() as { count: bigint };

    assert.equal(order.state, "CUSTOMER_CANCELLED");
    assert.equal(reservation.status, "RELEASED");
    assert.equal(providerCount.count, 0n);
  } finally {
    provider.close();
    database.close();
  }
});

test("mapping invalidation after authorization blocks supplier call and retains reservation", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const { orderId } = authorizedOrder(database);
    const poId = createIntent(database, orderId);

    database
      .prepare(
        `
          UPDATE packaged_trade_units
          SET
            mapping_status = 'INVALIDATED',
            invalidation_reason = 'LATE_IDENTITY_CONFLICT',
            updated_at = '2026-10-07T00:13:10.000Z'
          WHERE id = 'trade-1'
        `,
      )
      .run();

    assert.throws(
      () =>
        submitPurchaseOnce(
          database,
          poId,
          provider,
          "2026-10-07T00:13:30.000Z",
        ),
      /stale, cancelled, invalidated, or unresolved/,
    );

    const po = database
      .prepare("SELECT state FROM purchase_orders WHERE id = ?")
      .get(poId) as { state: string };
    const reservation = database
      .prepare(
        "SELECT status FROM reservations WHERE order_id = ?",
      )
      .get(orderId) as { status: string };
    const providerCount = provider.database
      .prepare(
        "SELECT COUNT(*) AS count FROM supplier_purchase_history",
      )
      .get() as { count: bigint };

    assert.equal(po.state, "INTENT_RECORDED");
    assert.equal(reservation.status, "ACTIVE");
    assert.equal(providerCount.count, 0n);
  } finally {
    provider.close();
    database.close();
  }
});

test("provider success followed by local failure becomes unknown and reconciles without second submission", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter(
    ":memory:",
    "CONFIRM",
  );

  try {
    const { orderId } = authorizedOrder(database);
    const poId = createIntent(database, orderId);

    provider.beforeReturn = () => {
      throw new Error("simulated process failure after provider commit");
    };

    assert.throws(
      () =>
        submitPurchaseOnce(
          database,
          poId,
          provider,
          "2026-10-07T00:13:30.000Z",
        ),
      /simulated process failure/,
    );

    const afterFailure = database
      .prepare(
        `
          SELECT po.state AS po_state, o.state AS order_state
          FROM purchase_orders po
          JOIN orders o ON o.id = po.order_id
          WHERE po.id = ?
        `,
      )
      .get(poId) as {
      po_state: string;
      order_state: string;
    };
    const providerCount = provider.database
      .prepare(
        "SELECT COUNT(*) AS count FROM supplier_purchase_history",
      )
      .get() as { count: bigint };

    assert.equal(afterFailure.po_state, "PURCHASE_UNKNOWN");
    assert.equal(afterFailure.order_state, "PAYMENT_UNKNOWN");
    assert.equal(providerCount.count, 1n);

    provider.beforeReturn = null;

    assert.throws(
      () =>
        submitPurchaseOnce(
          database,
          poId,
          provider,
          "2026-10-07T00:14:00.000Z",
        ),
      /reconcile instead/,
    );

    assert.equal(
      reconcilePurchase(
        database,
        poId,
        provider,
        "2026-10-07T00:14:00.000Z",
      ),
      true,
    );

    const final = database
      .prepare(
        `
          SELECT po.state AS po_state, o.state AS order_state
          FROM purchase_orders po
          JOIN orders o ON o.id = po.order_id
          WHERE po.id = ?
        `,
      )
      .get(poId) as {
      po_state: string;
      order_state: string;
    };
    const finalProviderCount = provider.database
      .prepare(
        "SELECT COUNT(*) AS count FROM supplier_purchase_history",
      )
      .get() as { count: bigint };
    const stock = database
      .prepare(
        `
          SELECT consumed_units
          FROM supply_pools
          WHERE supplier_id = 'supplier-1'
            AND supplier_sku = 'SKU-1'
        `,
      )
      .get() as { consumed_units: bigint };

    assert.equal(final.po_state, "CONFIRMED");
    assert.equal(final.order_state, "PO_CONFIRMED");
    assert.equal(finalProviderCount.count, 1n);
    assert.equal(stock.consumed_units, 1n);
  } finally {
    provider.close();
    database.close();
  }
});

test("explicit unknown provider result remains quarantined until authoritative history resolves it", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter(
    ":memory:",
    "UNKNOWN",
  );

  try {
    const { orderId } = authorizedOrder(database);
    const poId = createIntent(database, orderId);

    submitPurchaseOnce(
      database,
      poId,
      provider,
      "2026-10-07T00:13:30.000Z",
    );

    assert.equal(
      reconcilePurchase(
        database,
        poId,
        provider,
        "2026-10-07T00:14:00.000Z",
      ),
      false,
    );

    const po = database
      .prepare("SELECT state FROM purchase_orders WHERE id = ?")
      .get(poId) as { state: string };
    const exception = database
      .prepare(
        `
          SELECT state, exposure_reserved
          FROM exceptions
          WHERE order_id = ?
            AND exception_type = 'PURCHASE_UNKNOWN'
        `,
      )
      .get(orderId) as {
      state: string;
      exposure_reserved: bigint;
    };

    assert.equal(po.state, "PURCHASE_UNKNOWN");
    assert.equal(exception.state, "OPEN");
    assert.equal(exception.exposure_reserved, 1n);

    const auth = database
      .prepare(
        `
          SELECT
            a.supplier_id,
            a.supplier_sku,
            a.destination_key,
            a.quantity,
            a.maximum_amount_paise,
            po.idempotency_key,
            po.client_po_ref
          FROM purchase_orders po
          JOIN purchase_authorizations a
            ON a.id = po.authorization_id
          WHERE po.id = ?
        `,
      )
      .get(poId) as {
      supplier_id: string;
      supplier_sku: string;
      destination_key: string;
      quantity: bigint;
      maximum_amount_paise: bigint;
      idempotency_key: string;
      client_po_ref: string;
    };

    provider.recordRecoveredResult(
      {
        idempotencyKey: auth.idempotency_key,
        clientPoRef: auth.client_po_ref,
        supplierId: auth.supplier_id,
        supplierSku: auth.supplier_sku,
        amountPaise: Number(auth.maximum_amount_paise),
        quantity: Number(auth.quantity),
        destinationKey: auth.destination_key,
        submittedAt: "2026-10-07T00:13:30.000Z",
      },
      "CONFIRMED",
    );

    assert.equal(
      reconcilePurchase(
        database,
        poId,
        provider,
        "2026-10-07T00:15:00.000Z",
      ),
      true,
    );
  } finally {
    provider.close();
    database.close();
  }
});

test("confirmed purchase consumption survives quote refresh until explicit replenishment", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const fixture = seedSingleSkuFixture(database, {
      allocatedUnits: 5,
      availableUnits: 5,
    });
    const orderId = ingestSingleOrder(database, "CONSUME");
    authorizeSingleOrder(
      database,
      orderId,
      fixture.sourceOfferId,
    );
    const poId = createIntent(database, orderId);

    submitPurchaseOnce(
      database,
      poId,
      provider,
      "2026-10-07T00:13:30.000Z",
    );

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        JSON.stringify({
          supplierId: "supplier-1",
          sourceVersion: "quote-v2",
          sourceRef: "quote-v2",
          observedAt: "2026-10-07T00:14:00.000Z",
          offers: [
            {
              productId: "product-1",
              fulfilmentRouteId: "route-1",
              supplierSku: "SKU-1",
              grossCostPaise: 35_000,
              taxRateBps: 1_800,
              allocatedUnits: 5,
              availableUnits: 5,
              validFrom: "2026-10-07T00:00:00.000Z",
              validUntil: "2026-10-08T00:00:00.000Z",
              package: {
                packedWeightGrams: 650,
                lengthMm: 220,
                widthMm: 160,
                heightMm: 90,
              },
            },
          ],
        }),
      ),
    );

    const capacity = readSupplyPoolCapacity(
      database,
      fixture.supplyPoolId,
      1n,
    );

    assert.equal(capacity.allocatedUnits, 5n);
    assert.equal(capacity.consumedUnits, 1n);
    assert.equal(capacity.committedUnits, 0n);
    assert.equal(capacity.publicCapacityUnits, 3n);
  } finally {
    provider.close();
    database.close();
  }
});
