import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { parseSupplierFeedJson } from "./feed.ts";
import {
  evaluateLatestSourceOffer,
  evaluateOfferFreshness,
  getLatestSourceOffer,
  type SourceOfferSnapshot,
} from "./freshness.ts";
import { importSupplierFeed } from "./importer.ts";

const NOW = "2026-10-07T00:00:00.000Z";

function snapshot(
  overrides: Partial<SourceOfferSnapshot> = {},
): SourceOfferSnapshot {
  return {
    id: "offer-1",
    supplierId: "supplier-1",
    productId: "product-1",
    supplierSku: "SKU-001",
    grossCostPaise: 35_000n,
    allocatedUnits: 10n,
    availableUnits: 8n,
    validFrom: "2026-10-07T00:00:00.000Z",
    validUntil: "2026-10-08T00:00:00.000Z",
    observedAt: "2026-10-07T00:05:00.000Z",
    sourceVersion: "quote-v1",
    sourceRef: "fixture.json",
    ...overrides,
  };
}

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

function supplierFeed(
  observedAt: string,
  availableUnits: number,
  sourceVersion: string,
): string {
  return JSON.stringify({
    supplierId: "supplier-1",
    sourceVersion,
    sourceRef: `${sourceVersion}.json`,
    observedAt,
    offers: [
      {
        productId: "product-1",
        fulfilmentRouteId: "route-1",
        supplierSku: "SKU-001",
        grossCostPaise: 35_000,
        taxRateBps: 1_800,
        allocatedUnits: 10,
        availableUnits,
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
  });
}

test("fresh offer is exposable inside validity and age limits", () => {
  const decision = evaluateOfferFreshness(
    snapshot(),
    "2026-10-07T00:10:00.000Z",
    {
      maximumObservationAgeSeconds: 600,
    },
  );

  assert.equal(decision.state, "FRESH");
  assert.equal(decision.exposable, true);
  assert.equal(decision.ageSeconds, 300);
});

test("offer exactly at maximum age is still fresh", () => {
  const decision = evaluateOfferFreshness(
    snapshot(),
    "2026-10-07T00:15:00.000Z",
    {
      maximumObservationAgeSeconds: 600,
    },
  );

  assert.equal(decision.state, "FRESH");
  assert.equal(decision.exposable, true);
  assert.equal(decision.ageSeconds, 600);
});

test("offer beyond maximum age becomes stale and unavailable", () => {
  const decision = evaluateOfferFreshness(
    snapshot(),
    "2026-10-07T00:15:01.000Z",
    {
      maximumObservationAgeSeconds: 600,
    },
  );

  assert.equal(decision.state, "STALE");
  assert.equal(decision.exposable, false);
  assert.equal(decision.ageSeconds, 601);
});

test("not-yet-valid, expired, out-of-stock, and missing offers block exposure", () => {
  assert.equal(
    evaluateOfferFreshness(
      snapshot(),
      "2026-10-06T23:59:59.000Z",
      { maximumObservationAgeSeconds: 10_000 },
    ).state,
    "NOT_YET_VALID",
  );

  assert.equal(
    evaluateOfferFreshness(
      snapshot(),
      "2026-10-08T00:00:00.000Z",
      { maximumObservationAgeSeconds: 100_000 },
    ).state,
    "EXPIRED",
  );

  assert.equal(
    evaluateOfferFreshness(
      snapshot({ availableUnits: 0n }),
      "2026-10-07T00:10:00.000Z",
      { maximumObservationAgeSeconds: 600 },
    ).state,
    "OUT_OF_STOCK",
  );

  const missing = evaluateOfferFreshness(
    null,
    "2026-10-07T00:10:00.000Z",
    { maximumObservationAgeSeconds: 600 },
  );
  assert.equal(missing.state, "MISSING");
  assert.equal(missing.exposable, false);
});

test("future observation timestamps fail instead of becoming negative age", () => {
  assert.throws(
    () =>
      evaluateOfferFreshness(
        snapshot({
          observedAt: "2026-10-07T00:11:00.000Z",
        }),
        "2026-10-07T00:10:00.000Z",
        { maximumObservationAgeSeconds: 600 },
      ),
    /cannot be after the evaluation timestamp/,
  );
});

test("invalid freshness policy fails safely", () => {
  assert.throws(
    () =>
      evaluateOfferFreshness(
        snapshot(),
        "2026-10-07T00:10:00.000Z",
        { maximumObservationAgeSeconds: -1 },
      ),
    /non-negative safe integer/,
  );
});

test("latest supplier snapshot wins even when it is out of stock", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        supplierFeed(
          "2026-10-07T00:05:00.000Z",
          8,
          "quote-v1",
        ),
      ),
    );

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        supplierFeed(
          "2026-10-07T00:09:00.000Z",
          0,
          "quote-v2",
        ),
      ),
    );

    const latest = getLatestSourceOffer(
      database,
      "supplier-1",
      "SKU-001",
    );

    assert.equal(latest?.sourceVersion, "quote-v2");
    assert.equal(latest?.availableUnits, 0n);

    const decision = evaluateLatestSourceOffer(
      database,
      "supplier-1",
      "SKU-001",
      "2026-10-07T00:10:00.000Z",
      { maximumObservationAgeSeconds: 600 },
    );

    assert.equal(decision.state, "OUT_OF_STOCK");
    assert.equal(decision.exposable, false);
    assert.equal(decision.offer?.sourceVersion, "quote-v2");
  } finally {
    database.close();
  }
});

test("latest stale snapshot does not fall back to an older fresh-looking offer", () => {
  const database = openDatabase(":memory:", {
    appliedAt: NOW,
  });

  try {
    seed(database);

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        supplierFeed(
          "2026-10-07T00:01:00.000Z",
          8,
          "quote-v1",
        ),
      ),
    );

    importSupplierFeed(
      database,
      parseSupplierFeedJson(
        supplierFeed(
          "2026-10-07T00:05:00.000Z",
          7,
          "quote-v2",
        ),
      ),
    );

    const decision = evaluateLatestSourceOffer(
      database,
      "supplier-1",
      "SKU-001",
      "2026-10-07T00:20:01.000Z",
      { maximumObservationAgeSeconds: 900 },
    );

    assert.equal(decision.offer?.sourceVersion, "quote-v2");
    assert.equal(decision.state, "STALE");
    assert.equal(decision.exposable, false);
  } finally {
    database.close();
  }
});
