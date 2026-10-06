import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { parseSupplierFeedJson } from "./feed.ts";
import { importSupplierFeed } from "./importer.ts";

const NOW = "2026-10-07T00:00:00.000Z";

function seed(database: ReturnType<typeof openDatabase>): void {
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "product-1",
      "Acme",
      "Acme",
      "Model 1",
      "MPN-1",
      "new",
      "IN",
      NOW,
      NOW,
    );

  database
    .prepare(
      `
        INSERT INTO suppliers (
          id,
          legal_name,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      "supplier-1",
      "Acme Distributor Pvt Ltd",
      "verified",
      NOW,
      NOW,
    );

  database
    .prepare(
      `
        INSERT INTO fulfilment_routes (
          id,
          supplier_id,
          dispatch_country,
          dispatch_region,
          single_unit_dispatch_verified,
          return_route_verified,
          active,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "route-1",
      "supplier-1",
      "IN",
      "KA",
      1,
      1,
      1,
      NOW,
      NOW,
    );
}

function feedJson(
  overrides: Record<string, unknown> = {},
): string {
  const feed = {
    supplierId: "supplier-1",
    sourceVersion: "quote-2026-10-07-v1",
    sourceRef: "local-fixture.json",
    observedAt: "2026-10-07T00:05:00.000Z",
    offers: [
      {
        productId: "product-1",
        fulfilmentRouteId: "route-1",
        supplierSku: "SKU-001",
        grossCostPaise: 35_000,
        taxRateBps: 1_800,
        allocatedUnits: 10,
        availableUnits: 8,
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
    ...overrides,
  };

  return JSON.stringify(feed);
}

test("parses a strict local JSON supplier feed", () => {
  const feed = parseSupplierFeedJson(feedJson());

  assert.equal(feed.supplierId, "supplier-1");
  assert.equal(feed.offers.length, 1);
  assert.equal(feed.offers[0]?.grossCostPaise, 35_000);
  assert.equal(feed.offers[0]?.package.packedWeightGrams, 650);
});

test("rejects malformed or non-canonical supplier feed data", () => {
  assert.throws(
    () =>
      parseSupplierFeedJson(
        feedJson({
          observedAt: "2026-10-07 00:05:00",
        }),
      ),
    /canonical UTC ISO timestamp/,
  );

  const invalid = JSON.parse(feedJson()) as Record<string, unknown>;
  const offers = invalid.offers as Array<Record<string, unknown>>;
  const first = offers[0];
  if (first === undefined) {
    throw new Error("Fixture offer missing.");
  }
  first.availableUnits = 11;

  assert.throws(
    () => parseSupplierFeedJson(JSON.stringify(invalid)),
    /availableUnits cannot exceed allocatedUnits/,
  );
});

test("imports the same feed repeatedly without duplicates", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);
    const feed = parseSupplierFeedJson(feedJson());

    assert.deepEqual(importSupplierFeed(database, feed), {
      inserted: 1,
      unchanged: 0,
    });
    assert.deepEqual(importSupplierFeed(database, feed), {
      inserted: 0,
      unchanged: 1,
    });

    const row = database
      .prepare("SELECT COUNT(*) AS count FROM source_offers")
      .get() as { count: bigint };

    assert.equal(row.count, 1n);
  } finally {
    database.close();
  }
});

test("rejects a conflicting replay instead of overwriting history", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);
    const original = parseSupplierFeedJson(feedJson());
    importSupplierFeed(database, original);

    const changed = JSON.parse(feedJson()) as Record<string, unknown>;
    const offers = changed.offers as Array<Record<string, unknown>>;
    const first = offers[0];
    if (first === undefined) {
      throw new Error("Fixture offer missing.");
    }
    first.grossCostPaise = 36_000;

    const replay = parseSupplierFeedJson(JSON.stringify(changed));

    assert.throws(
      () => importSupplierFeed(database, replay),
      /Conflicting replay/,
    );

    const row = database
      .prepare(
        `
          SELECT gross_cost_paise
          FROM source_offers
          WHERE supplier_sku = ?
        `,
      )
      .get("SKU-001") as { gross_cost_paise: bigint };

    assert.equal(row.gross_cost_paise, 35_000n);
  } finally {
    database.close();
  }
});

test("rejects unknown product mappings with no partial import", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);

    const changed = JSON.parse(feedJson()) as Record<string, unknown>;
    const offers = changed.offers as Array<Record<string, unknown>>;
    const first = offers[0];
    if (first === undefined) {
      throw new Error("Fixture offer missing.");
    }
    first.productId = "missing-product";

    const feed = parseSupplierFeedJson(JSON.stringify(changed));

    assert.throws(
      () => importSupplierFeed(database, feed),
      /Unknown product/,
    );

    const row = database
      .prepare("SELECT COUNT(*) AS count FROM source_offers")
      .get() as { count: bigint };

    assert.equal(row.count, 0n);
  } finally {
    database.close();
  }
});

test("persists exact supplier price, stock, route, and package facts", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);
    importSupplierFeed(database, parseSupplierFeedJson(feedJson()));

    const row = database
      .prepare(
        `
          SELECT
            gross_cost_paise,
            tax_rate_bps,
            allocated_units,
            available_units,
            fulfilment_route_id,
            packed_weight_grams,
            package_length_mm,
            package_width_mm,
            package_height_mm,
            source_version,
            source_ref,
            observed_at
          FROM source_offers
          WHERE supplier_sku = ?
        `,
      )
      .get("SKU-001") as {
        gross_cost_paise: bigint;
        tax_rate_bps: bigint;
        allocated_units: bigint;
        available_units: bigint;
        fulfilment_route_id: string;
        packed_weight_grams: bigint;
        package_length_mm: bigint;
        package_width_mm: bigint;
        package_height_mm: bigint;
        source_version: string;
        source_ref: string;
        observed_at: string;
      };

    assert.equal(row.gross_cost_paise, 35_000n);
    assert.equal(row.tax_rate_bps, 1_800n);
    assert.equal(row.allocated_units, 10n);
    assert.equal(row.available_units, 8n);
    assert.equal(row.fulfilment_route_id, "route-1");
    assert.equal(row.packed_weight_grams, 650n);
    assert.equal(row.package_length_mm, 220n);
    assert.equal(row.package_width_mm, 160n);
    assert.equal(row.package_height_mm, 90n);
    assert.equal(row.source_version, "quote-2026-10-07-v1");
    assert.equal(row.source_ref, "local-fixture.json");
    assert.equal(row.observed_at, "2026-10-07T00:05:00.000Z");
  } finally {
    database.close();
  }
});

test("rejects a different source version at the same observation timestamp", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);
    importSupplierFeed(
      database,
      parseSupplierFeedJson(feedJson()),
    );

    const changed = JSON.parse(feedJson()) as Record<string, unknown>;
    changed.sourceVersion = "quote-2026-10-07-v2";

    const conflicting = parseSupplierFeedJson(
      JSON.stringify(changed),
    );

    assert.throws(
      () => importSupplierFeed(database, conflicting),
      /Conflicting replay/,
    );

    const row = database
      .prepare("SELECT COUNT(*) AS count FROM source_offers")
      .get() as { count: bigint };

    assert.equal(row.count, 1n);
  } finally {
    database.close();
  }
});
