import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { validateAndAuthorizeOrder } from "./authorization.ts";
import { ingestMarketplaceOrder } from "./ingest.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function seedOrderAuthorizationFixture(
  database: ReturnType<typeof openDatabase>,
  allocatedUnits: number,
  availableUnits: number,
): void {
  database
    .prepare(
      `
        INSERT INTO products (
          id,
          brand,
          manufacturer,
          model,
          mpn,
          condition,
          market_region,
          created_at,
          updated_at
        ) VALUES (
          'product-auth',
          'Acme',
          'Acme',
          'Model',
          'MPN',
          'new',
          'IN',
          ?,
          ?
        )
      `,
    )
    .run(T0, T0);

  database
    .prepare(
      `
        INSERT INTO suppliers (
          id,
          legal_name,
          status,
          created_at,
          updated_at
        ) VALUES (
          'supplier-auth',
          'Supplier Auth',
          'verified',
          ?,
          ?
        )
      `,
    )
    .run(T0, T0);

  database
    .prepare(
      `
        INSERT INTO source_offers (
          id,
          supplier_id,
          product_id,
          supplier_sku,
          gross_cost_paise,
          tax_rate_bps,
          allocated_units,
          available_units,
          valid_from,
          valid_until,
          observed_at,
          source_version,
          source_ref
        ) VALUES (
          'offer-auth',
          'supplier-auth',
          'product-auth',
          'SKU-AUTH',
          35000,
          1800,
          ?,
          ?,
          '2026-10-07T00:00:00.000Z',
          '2026-10-08T00:00:00.000Z',
          '2026-10-07T00:01:00.000Z',
          'v1',
          'fixture'
        )
      `,
    )
    .run(allocatedUnits, availableUnits);

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
        ) VALUES (
          'order-auth',
          'SIM',
          'REMOTE-AUTH',
          'RECEIVED',
          1,
          ?,
          ?,
          '{}'
        )
      `,
    )
    .run(T0, T0);
}

test("authorization rolls back order state and audit when reservation fails", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedOrderAuthorizationFixture(database, 0, 0);

    assert.throws(
      () =>
        validateAndAuthorizeOrder(database, {
          orderId: "order-auth",
          sourceOfferId: "offer-auth",
          units: 1,
          cashPaise: 35_000,
          availableCashPaise: 100_000,
          identityOk: true,
          sourceFresh: true,
          economicsOk: true,
          routeOk: true,
          authorizedAt: "2026-10-07T00:02:00.000Z",
        }),
      /Insufficient allocated supplier units/,
    );

    const order = database
      .prepare(
        "SELECT state, version FROM orders WHERE id = 'order-auth'",
      )
      .get() as { state: string; version: bigint };
    const reservations = database
      .prepare(
        "SELECT COUNT(*) AS count FROM reservations WHERE order_id = 'order-auth'",
      )
      .get() as { count: bigint };
    const audits = database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE subject_id = 'order-auth'",
      )
      .get() as { count: bigint };

    assert.equal(order.state, "RECEIVED");
    assert.equal(order.version, 1n);
    assert.equal(reservations.count, 0n);
    assert.equal(audits.count, 0n);
  } finally {
    database.close();
  }
});

test("failed validation releases reserved stock and cash", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedOrderAuthorizationFixture(database, 5, 5);

    validateAndAuthorizeOrder(database, {
      orderId: "order-auth",
      sourceOfferId: "offer-auth",
      units: 1,
      cashPaise: 35_000,
      availableCashPaise: 100_000,
      identityOk: false,
      sourceFresh: true,
      economicsOk: true,
      routeOk: true,
      authorizedAt: "2026-10-07T00:02:00.000Z",
    });

    const order = database
      .prepare("SELECT state FROM orders WHERE id = 'order-auth'")
      .get() as { state: string };
    const reservation = database
      .prepare(
        `
          SELECT status
          FROM reservations
          WHERE order_id = 'order-auth'
            AND source_offer_id = 'offer-auth'
        `,
      )
      .get() as { status: string };

    assert.equal(order.state, "IDENTITY_CONFLICT");
    assert.equal(reservation.status, "RELEASED");
  } finally {
    database.close();
  }
});

function seedOrderIngestFixture(
  database: ReturnType<typeof openDatabase>,
): void {
  database
    .prepare(
      `
        INSERT INTO products (
          id,
          brand,
          manufacturer,
          model,
          mpn,
          condition,
          market_region,
          created_at,
          updated_at
        ) VALUES (
          'product-ingest',
          'Acme',
          'Acme',
          'Model',
          'MPN',
          'new',
          'IN',
          ?,
          ?
        )
      `,
    )
    .run(T0, T0);

  database
    .prepare(
      `
        INSERT INTO suppliers (
          id,
          legal_name,
          status,
          created_at,
          updated_at
        ) VALUES (
          'supplier-ingest',
          'Supplier Ingest',
          'verified',
          ?,
          ?
        )
      `,
    )
    .run(T0, T0);

  database
    .prepare(
      `
        INSERT INTO source_offers (
          id,
          supplier_id,
          product_id,
          supplier_sku,
          gross_cost_paise,
          tax_rate_bps,
          allocated_units,
          available_units,
          valid_from,
          valid_until,
          observed_at,
          source_version,
          source_ref
        ) VALUES (
          'offer-ingest',
          'supplier-ingest',
          'product-ingest',
          'SKU-INGEST',
          35000,
          1800,
          5,
          5,
          '2026-10-07T00:00:00.000Z',
          '2026-10-08T00:00:00.000Z',
          '2026-10-07T00:01:00.000Z',
          'v1',
          'fixture'
        )
      `,
    )
    .run();

  database
    .prepare(
      `
        INSERT INTO packaged_trade_units (
          id,
          product_id,
          variant,
          edition,
          pack_count,
          condition,
          market_region,
          barcode_type,
          barcode_value,
          mapping_version,
          mapping_status,
          invalidation_reason,
          created_at,
          updated_at,
          physical_verified_at
        ) VALUES (
          'trade-ingest',
          'product-ingest',
          'standard',
          '2026',
          1,
          'new',
          'IN',
          'GTIN13',
          '4006381333931',
          1,
          'APPROVED',
          NULL,
          ?,
          ?,
          ?
        )
      `,
    )
    .run(T0, T0, T0);

  database
    .prepare(
      `
        INSERT INTO marketplace_catalogue_items (
          id,
          marketplace,
          marketplace_catalogue_id,
          trade_unit_id,
          identity_class,
          mapping_version,
          mapping_status,
          evidence_ref,
          created_at,
          updated_at
        ) VALUES (
          'market-item-ingest',
          'SIM',
          'CAT-INGEST',
          'trade-ingest',
          'A',
          1,
          'APPROVED',
          'fixture',
          ?,
          ?
        )
      `,
    )
    .run(T0, T0);

  database
    .prepare(
      `
        INSERT INTO listings (
          id,
          marketplace,
          seller_sku,
          marketplace_catalogue_item_id,
          source_offer_id,
          desired_price_paise,
          desired_quantity,
          observed_price_paise,
          observed_quantity,
          desired_state,
          observed_state,
          remote_version,
          version,
          updated_at
        ) VALUES (
          'listing-ingest',
          'SIM',
          'SELLER-INGEST',
          'market-item-ingest',
          'offer-ingest',
          79900,
          1,
          79900,
          1,
          'ACTIVE',
          'ACTIVE',
          '1',
          1,
          ?
        )
      `,
    )
    .run(T0);

  database
    .prepare(
      `
        INSERT INTO simulated_marketplace_listings (
          marketplace,
          seller_sku,
          price_paise,
          quantity,
          state,
          remote_version,
          updated_at
        ) VALUES (
          'SIM',
          'SELLER-INGEST',
          79900,
          1,
          'ACTIVE',
          1,
          ?
        )
      `,
    )
    .run(T0);
}

test("identical order replay is idempotent but changed replay is rejected", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedOrderIngestFixture(database);

    const event = {
      marketplace: "SIM",
      marketplaceOrderId: "REMOTE-INGEST-1",
      sellerSku: "SELLER-INGEST",
      quantity: 1,
      acceptedPricePaise: 79_900,
      receivedAt: "2026-10-07T00:02:00.000Z",
      economicsSnapshot: {
        decisionProfitPaise: 14_509,
      },
    } as const;

    const first = ingestMarketplaceOrder(database, event);
    const second = ingestMarketplaceOrder(database, event);

    assert.equal(second, first);

    const counts = database
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM orders) AS orders_count,
            (SELECT COUNT(*) FROM order_items) AS items_count
        `,
      )
      .get() as {
      orders_count: bigint;
      items_count: bigint;
    };
    const listing = database
      .prepare(
        `
          SELECT observed_quantity
          FROM listings
          WHERE id = 'listing-ingest'
        `,
      )
      .get() as { observed_quantity: bigint };

    assert.equal(counts.orders_count, 1n);
    assert.equal(counts.items_count, 1n);
    assert.equal(listing.observed_quantity, 0n);

    assert.throws(
      () =>
        ingestMarketplaceOrder(database, {
          ...event,
          acceptedPricePaise: 78_900,
        }),
      /Conflicting replay for marketplace order/,
    );

    const after = database
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM orders) AS orders_count,
            (SELECT COUNT(*) FROM order_items) AS items_count
        `,
      )
      .get() as {
      orders_count: bigint;
      items_count: bigint;
    };

    assert.equal(after.orders_count, 1n);
    assert.equal(after.items_count, 1n);
  } finally {
    database.close();
  }
});
