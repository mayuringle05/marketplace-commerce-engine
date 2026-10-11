import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  evaluateFulfilmentCompatibility,
  REQUIRED_FULFILMENT_EVIDENCE,
} from "./compatibility.ts";
import {
  seedSingleSkuFixture,
} from "../test/commerce-fixture.ts";
import {
  syncListingToSimulatedMarketplace,
} from "../listings/service.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function insertEvidence(
  database: ReturnType<typeof openDatabase>,
  type: string,
  value: string,
  observedAt: string,
  suffix: string,
): void {
  database
    .prepare(
      `
        INSERT INTO observations (
          id,
          subject_type,
          subject_id,
          observation_type,
          value_text,
          source_ref,
          evidence_hash,
          observed_at
        ) VALUES (?, 'fulfilment_route', 'route-1', ?, ?, ?, ?, ?)
      `,
    )
    .run(
      `obs-${suffix}`,
      type,
      value,
      `contract-${suffix}`,
      `hash-${suffix}`,
      observedAt,
    );
}

test("fulfilment compatibility fails closed until every packaging requirement is verified", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    database
      .prepare(
        `
          INSERT INTO suppliers (
            id, legal_name, status, created_at, updated_at
          ) VALUES (
            'supplier-1', 'Supplier One', 'verified', ?, ?
          )
        `,
      )
      .run(T0, T0);
    database
      .prepare(
        `
          INSERT INTO fulfilment_routes (
            id, supplier_id, dispatch_country, dispatch_region,
            single_unit_dispatch_verified, return_route_verified,
            active, created_at, updated_at
          ) VALUES (
            'route-1', 'supplier-1', 'IN', 'KA',
            1, 1, 1, ?, ?
          )
        `,
      )
      .run(T0, T0);

    const missing = evaluateFulfilmentCompatibility(
      database,
      "route-1",
      "2026-10-07T00:05:00.000Z",
    );
    assert.equal(missing.compatible, false);
    assert.equal(
      missing.blockingReasons.length,
      REQUIRED_FULFILMENT_EVIDENCE.length,
    );

    REQUIRED_FULFILMENT_EVIDENCE.forEach((type, index) => {
      insertEvidence(
        database,
        type,
        "VERIFIED",
        "2026-10-07T00:01:00.000Z",
        `verified-${index}`,
      );
    });

    const verified = evaluateFulfilmentCompatibility(
      database,
      "route-1",
      "2026-10-07T00:05:00.000Z",
    );
    assert.equal(verified.compatible, true);
    assert.deepEqual(verified.blockingReasons, []);

    insertEvidence(
      database,
      "NO_SUPPLIER_BRANDING",
      "REVOKED",
      "2026-10-07T00:04:00.000Z",
      "branding-revoked",
    );

    const revoked = evaluateFulfilmentCompatibility(
      database,
      "route-1",
      "2026-10-07T00:05:00.000Z",
    );
    assert.equal(revoked.compatible, false);
    assert.deepEqual(
      revoked.blockingReasons,
      ["NO_SUPPLIER_BRANDING_NOT_VERIFIED"],
    );
  } finally {
    database.close();
  }
});

test("listing mutation is blocked when packaging evidence is revoked", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database);

    insertEvidence(
      database,
      "NEUTRAL_OUTER_PACKAGING",
      "REVOKED",
      "2026-10-07T00:11:30.000Z",
      "neutral-packaging-revoked",
    );

    assert.throws(
      () =>
        syncListingToSimulatedMarketplace(database, {
          marketplace: "SIM",
          sellerSku: "SELLER-1",
          marketplaceCatalogueItemId: "market-item-1",
          opportunityId: fixture.opportunityId,
          sourceOfferId: fixture.sourceOfferId,
          pricePaise: 79_900,
          requestedQuantity: 1,
          updatedAt: "2026-10-07T00:12:00.000Z",
        }),
      /Fulfilment compatibility not verified/,
    );
  } finally {
    database.close();
  }
});
