import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  findActiveEconomicsProfile,
  parseMarketplaceEconomicsProfileJson,
  upsertMarketplaceEconomicsProfile,
} from "./economics-profile.ts";

const AT = "2026-10-11T10:00:00.000Z";

function profile(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    profileId: "amazon-default-2026-10",
    marketplace: "AMAZON_IN",
    categoryScope: "*",
    verificationStatus: "VERIFIED",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
    effectiveUntil: "2026-11-01T00:00:00.000Z",
    verifiedAt: "2026-10-10T00:00:00.000Z",
    sourceVersion: "official-rate-card-2026-10",
    sourceRefs: [
      "https://seller.example/rate-card",
    ],
    outputTaxRateBps: 1_800,
    supplierTaxRateBps: 1_800,
    supplierTaxRecoverable: true,
    marketplaceFeeBps: 1_200,
    fixedMarketplaceFeePaise: 2_000,
    shippingPaise: 4_000,
    packingHandlingPaise: 1_500,
    costTaxRateBps: 1_800,
    rtoProbabilityPpm: 50_000,
    rtoCostPaise: 8_000,
    customerReturnProbabilityPpm: 40_000,
    customerReturnCostPaise: 12_000,
    feeUncertaintyPaise: 500,
    unmodelledPriceRiskPaise: 500,
    supplierRiskPaise: 300,
    allocatedOverheadPaise: 500,
    minimumDecisionProfitPaise: 5_000,
    minimumDecisionMarginBps: 1_200,
    minimumCashRoiBps: 1_500,
    availableSingleOrderLossReservePaise: 100_000,
    maxInitialStockUnits: 8,
    maxInitialStockCapitalPaise: 300_000,
    ...overrides,
  });
}

test("verified economics profile is strict and selectable", () => {
  const parsed = parseMarketplaceEconomicsProfileJson(
    profile(),
  );
  assert.equal(parsed.marketplace, "AMAZON_IN");

  const database = openDatabase(":memory:", {
    appliedAt: AT,
  });
  try {
    upsertMarketplaceEconomicsProfile(
      database,
      parsed,
      AT,
    );
    const selected = findActiveEconomicsProfile(
      database,
      "AMAZON_IN",
      "desk organization",
      AT,
    );
    assert.equal(
      selected?.profileId,
      "amazon-default-2026-10",
    );
  } finally {
    database.close();
  }
});

test("economics profile refuses unverified assumptions", () => {
  assert.throws(
    () =>
      parseMarketplaceEconomicsProfileJson(
        profile({
          verificationStatus: "DRAFT",
        }),
      ),
    /explicitly marked VERIFIED/,
  );
});

test("category-specific economics profile wins over wildcard", () => {
  const database = openDatabase(":memory:", {
    appliedAt: AT,
  });

  try {
    upsertMarketplaceEconomicsProfile(
      database,
      parseMarketplaceEconomicsProfileJson(profile()),
      AT,
    );
    upsertMarketplaceEconomicsProfile(
      database,
      parseMarketplaceEconomicsProfileJson(
        profile({
          profileId: "amazon-desk-2026-10",
          categoryScope: "desk organization",
          sourceVersion: "desk-rate-card-2026-10",
        }),
      ),
      AT,
    );

    const selected = findActiveEconomicsProfile(
      database,
      "AMAZON_IN",
      "desk organization",
      AT,
    );
    assert.equal(selected?.profileId, "amazon-desk-2026-10");
  } finally {
    database.close();
  }
});
