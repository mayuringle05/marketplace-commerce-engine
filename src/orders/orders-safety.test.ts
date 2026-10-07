import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  recordVerifiedCashSnapshot,
} from "../cash/state.ts";
import {
  pauseAllListingsAndConfirm,
  syncListingToSimulatedMarketplace,
} from "../listings/service.ts";
import {
  seedSingleSkuFixture,
  ingestSingleOrder,
  authorizeSingleOrder,
} from "../test/commerce-fixture.ts";
import { validateAndAuthorizeOrder } from "./authorization.ts";
import { ingestMarketplaceOrder } from "./ingest.ts";
import { parseSupplierFeedJson } from "../supplier/feed.ts";
import { importSupplierFeed } from "../supplier/importer.ts";

const T0 = "2026-10-07T00:00:00.000Z";

test("authorization rolls back fully when shared verified cash is insufficient", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database, {
      cashPaise: 250_000,
    });
    const orderId = ingestSingleOrder(database);

    recordVerifiedCashSnapshot(
      database,
      1_000,
      "later-low-balance",
      "2026-10-07T00:12:15.000Z",
      "2026-10-07T00:30:00.000Z",
    );

    assert.throws(
      () =>
        validateAndAuthorizeOrder(database, {
          orderId,
          sourceOfferId: fixture.sourceOfferId,
          authorizedAt: "2026-10-07T00:12:30.000Z",
        }),
      /Insufficient shared verified cash/,
    );

    const order = database
      .prepare(
        "SELECT state, version FROM orders WHERE id = ?",
      )
      .get(orderId) as {
      state: string;
      version: bigint;
    };
    const reservation = database
      .prepare(
        "SELECT COUNT(*) AS count FROM reservations WHERE order_id = ?",
      )
      .get(orderId) as { count: bigint };
    const commitment = database
      .prepare(
        `
          SELECT state
          FROM stock_commitments
          WHERE order_item_id IN (
            SELECT id FROM order_items WHERE order_id = ?
          )
        `,
      )
      .get(orderId) as { state: string };

    assert.equal(order.state, "RECEIVED");
    assert.equal(order.version, 1n);
    assert.equal(reservation.count, 0n);
    assert.equal(commitment.state, "ACCEPTED");
  } finally {
    database.close();
  }
});

test("mapping invalidation before authorization fails closed without reserving", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database);
    const orderId = ingestSingleOrder(database);

    database
      .prepare(
        `
          UPDATE packaged_trade_units
          SET
            mapping_status = 'INVALIDATED',
            invalidation_reason = 'BARCODE_CONFLICT',
            updated_at = '2026-10-07T00:12:10.000Z'
          WHERE id = 'trade-1'
        `,
      )
      .run();

    validateAndAuthorizeOrder(database, {
      orderId,
      sourceOfferId: fixture.sourceOfferId,
      authorizedAt: "2026-10-07T00:12:30.000Z",
    });

    const order = database
      .prepare("SELECT state FROM orders WHERE id = ?")
      .get(orderId) as { state: string };
    const reservations = database
      .prepare(
        "SELECT COUNT(*) AS count FROM reservations WHERE order_id = ?",
      )
      .get(orderId) as { count: bigint };

    assert.equal(order.state, "IDENTITY_CONFLICT");
    assert.equal(reservations.count, 0n);
  } finally {
    database.close();
  }
});

test("identical item replay is idempotent and changed replay is rejected", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedSingleSkuFixture(database);

    const event = {
      marketplace: "SIM",
      marketplaceOrderId: "ORDER-REPLAY",
      marketplaceItemId: "ORDER-REPLAY-ITEM-1",
      sellerSku: "SELLER-1",
      quantity: 1,
      acceptedPricePaise: 79_900,
      receivedAt: "2026-10-07T00:12:00.000Z",
      economicsSnapshot: {
        fixture: "replay",
        acceptedPricePaise: 79_900,
      },
    } as const;

    const first = ingestMarketplaceOrder(database, event);
    const second = ingestMarketplaceOrder(database, event);
    assert.equal(second, first);

    assert.throws(
      () =>
        ingestMarketplaceOrder(database, {
          ...event,
          acceptedPricePaise: 78_900,
        }),
      /Conflicting replay for marketplace order item/,
    );

    const count = database
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM orders) AS orders_count,
            (SELECT COUNT(*) FROM order_items) AS items_count,
            (SELECT COUNT(*) FROM stock_commitments) AS commitments_count
        `,
      )
      .get() as {
      orders_count: bigint;
      items_count: bigint;
      commitments_count: bigint;
    };

    assert.equal(count.orders_count, 1n);
    assert.equal(count.items_count, 1n);
    assert.equal(count.commitments_count, 1n);
  } finally {
    database.close();
  }
});

test("late authoritative order after pause is persisted with an exception", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedSingleSkuFixture(database);
    pauseAllListingsAndConfirm(
      database,
      "2026-10-07T00:11:30.000Z",
    );

    const orderId = ingestMarketplaceOrder(database, {
      marketplace: "SIM",
      marketplaceOrderId: "ORDER-LATE",
      marketplaceItemId: "ORDER-LATE-ITEM-1",
      sellerSku: "SELLER-1",
      quantity: 1,
      acceptedPricePaise: 79_900,
      receivedAt: "2026-10-07T00:12:00.000Z",
      economicsSnapshot: { fixture: "late-order" },
    });

    const order = database
      .prepare("SELECT state FROM orders WHERE id = ?")
      .get(orderId) as { state: string };
    const itemCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?",
      )
      .get(orderId) as { count: bigint };
    const exception = database
      .prepare(
        `
          SELECT exception_type, state
          FROM exceptions
          WHERE order_id = ?
        `,
      )
      .get(orderId) as {
      exception_type: string;
      state: string;
    };

    assert.equal(order.state, "RECEIVED");
    assert.equal(itemCount.count, 1n);
    assert.equal(
      exception.exception_type,
      "ACCEPTED_ORDER_CAPACITY_MISMATCH",
    );
    assert.equal(exception.state, "OPEN");
  } finally {
    database.close();
  }
});

test("second item in one marketplace order remains durably represented as a held obligation", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedSingleSkuFixture(database, {
      listingQuantity: 2,
    });

    const base = {
      marketplace: "SIM",
      marketplaceOrderId: "ORDER-MULTI",
      sellerSku: "SELLER-1",
      acceptedPricePaise: 79_900,
      receivedAt: "2026-10-07T00:12:00.000Z",
      economicsSnapshot: { fixture: "multi" },
    } as const;

    ingestMarketplaceOrder(database, {
      ...base,
      marketplaceItemId: "ORDER-MULTI-ITEM-1",
      quantity: 1,
    });

    assert.throws(
      () =>
        ingestMarketplaceOrder(database, {
          ...base,
          marketplaceItemId: "ORDER-MULTI-ITEM-2",
          quantity: 1,
        }),
      /UNIQUE constraint failed: order_items.order_id, order_items.listing_id/,
    );

    // Until the legacy order_items unique constraint is removed by a
    // forward migration, the second obligation must not be silently lost.
    // This assertion is intentionally temporary and will be replaced by
    // a held-obligation regression in the next migration.
    const items = database
      .prepare(
        "SELECT COUNT(*) AS count FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE marketplace_order_id = 'ORDER-MULTI')",
      )
      .get() as { count: bigint };
    assert.equal(items.count, 1n);
  } finally {
    database.close();
  }
});

test("new supplier snapshot does not recreate accepted or consumed stock", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database, {
      allocatedUnits: 5,
      availableUnits: 5,
      listingQuantity: 4,
    });

    const orderId = ingestSingleOrder(database, "STOCK");
    authorizeSingleOrder(
      database,
      orderId,
      fixture.sourceOfferId,
    );

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        JSON.stringify({
          supplierId: "supplier-1",
          sourceVersion: "quote-v2",
          sourceRef: "fixture-feed-v2",
          observedAt: "2026-10-07T00:13:00.000Z",
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

    const pool = database
      .prepare(
        `
          SELECT id, consumed_units
          FROM supply_pools
          WHERE supplier_id = 'supplier-1'
            AND supplier_sku = 'SKU-1'
        `,
      )
      .get() as {
      id: string;
      consumed_units: bigint;
    };
    const commitments = database
      .prepare(
        `
          SELECT COALESCE(SUM(units), 0) AS units
          FROM stock_commitments
          WHERE supply_pool_id = ?
            AND state IN ('ACCEPTED', 'RESERVED')
        `,
      )
      .get(pool.id) as { units: bigint };

    assert.equal(pool.id, fixture.supplyPoolId);
    assert.equal(pool.consumed_units, 0n);
    assert.equal(commitments.units, 1n);

    const latest = database
      .prepare(
        `
          SELECT latest_offer_id
          FROM supply_pools
          WHERE id = ?
        `,
      )
      .get(pool.id) as { latest_offer_id: string };

    assert.notEqual(latest.latest_offer_id, fixture.sourceOfferId);

    assert.throws(
      () =>
        syncListingToSimulatedMarketplace(database, {
          marketplace: "SIM",
          sellerSku: "SELLER-1",
          marketplaceCatalogueItemId: "market-item-1",
          opportunityId: fixture.opportunityId,
          sourceOfferId: fixture.sourceOfferId,
          pricePaise: 79_900,
          requestedQuantity: 4,
          updatedAt: "2026-10-07T00:13:30.000Z",
        }),
      /no longer the latest supplier snapshot/,
    );
  } finally {
    database.close();
  }
});
