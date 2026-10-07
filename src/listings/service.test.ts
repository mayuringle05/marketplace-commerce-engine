import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { syncListingToSimulatedMarketplace } from "./service.ts";
import {
  seedSingleSkuFixture,
} from "../test/commerce-fixture.ts";
import { parseSupplierFeedJson } from "../supplier/feed.ts";
import { importSupplierFeed } from "../supplier/importer.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function sync(
  database: ReturnType<typeof openDatabase>,
  fixture: ReturnType<typeof seedSingleSkuFixture>,
  overrides: Partial<{
    pricePaise: number;
    updatedAt: string;
  }> = {},
): string {
  return syncListingToSimulatedMarketplace(database, {
    marketplace: "SIM",
    sellerSku: "SELLER-1",
    marketplaceCatalogueItemId: "market-item-1",
    opportunityId: fixture.opportunityId,
    sourceOfferId: fixture.sourceOfferId,
    pricePaise: overrides.pricePaise ?? 79_900,
    requestedQuantity: 1,
    updatedAt:
      overrides.updatedAt ??
      "2026-10-07T00:12:00.000Z",
  });
}

test("listing cannot use a LIST decision for an unrelated one-paise price", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database);

    assert.throws(
      () =>
        sync(database, fixture, {
          pricePaise: 1,
        }),
      /exact price approved by underwriting/,
    );
  } finally {
    database.close();
  }
});

test("listing recheck blocks suspended supplier and revoked route", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database);

    database
      .prepare(
        "UPDATE suppliers SET status = 'suspended' WHERE id = 'supplier-1'",
      )
      .run();

    assert.throws(
      () => sync(database, fixture),
      /Supplier or fulfilment route is not currently approved/,
    );

    database
      .prepare(
        "UPDATE suppliers SET status = 'verified' WHERE id = 'supplier-1'",
      )
      .run();
    database
      .prepare(
        "UPDATE fulfilment_routes SET active = 0 WHERE id = 'route-1'",
      )
      .run();

    assert.throws(
      () => sync(database, fixture),
      /Supplier or fulfilment route is not currently approved/,
    );
  } finally {
    database.close();
  }
});

test("newer zero-stock supplier snapshot invalidates the old listing decision", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database);

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        JSON.stringify({
          supplierId: "supplier-1",
          sourceVersion: "quote-v2",
          sourceRef: "quote-v2",
          observedAt: "2026-10-07T00:12:30.000Z",
          offers: [
            {
              productId: "product-1",
              fulfilmentRouteId: "route-1",
              supplierSku: "SKU-1",
              grossCostPaise: 35_000,
              taxRateBps: 1_800,
              allocatedUnits: 5,
              availableUnits: 0,
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

    assert.throws(
      () =>
        sync(database, fixture, {
          updatedAt: "2026-10-07T00:13:00.000Z",
        }),
      /no longer the latest supplier snapshot/,
    );
  } finally {
    database.close();
  }
});

test("cross-product trade-unit mapping cannot be backed by another product's supplier offer", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database);

    database
      .prepare(
        `
          INSERT INTO products (
            id, brand, manufacturer, model, mpn, condition,
            market_region, created_at, updated_at
          ) VALUES (
            'product-2', 'Other', 'Other', 'Model 2', 'MPN-2',
            'new', 'IN', ?, ?
          )
        `,
      )
      .run(T0, T0);

    database
      .prepare(
        `
          UPDATE packaged_trade_units
          SET product_id = 'product-2'
          WHERE id = 'trade-1'
        `,
      )
      .run();

    assert.throws(
      () => sync(database, fixture),
      /product, trade unit, source offer, or channel does not match/,
    );
  } finally {
    database.close();
  }
});
