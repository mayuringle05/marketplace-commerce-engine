import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMarketplaceEconomicsProfileJson,
} from "./economics-profile.ts";
import {
  evaluateDiscoveryCandidate,
  type DiscoveryCandidate,
} from "./product-discovery.ts";
import {
  buildResearchPricingStrategy,
} from "./pricing-strategy.ts";
import {
  buildVerifiedCommerceStrategy,
  classifyDemand,
} from "./verified-strategy.ts";

function candidate(): DiscoveryCandidate {
  return {
    candidateId: "desk-organizer-1",
    title: "Compact desk organizer tray",
    marketplace: "AMAZON_IN",
    category: "desk organization",
    expectedSellPricePaise: 69_900,
    estimatedSupplierCostPaise: 32_000,
    competitionScore: 28,
    trendConfidence: 84,
    demand: {
      reactive: 82,
      predictive: 80,
      structural: 78,
    },
    risk: {
      sizeDependent: false,
      fitSensitive: false,
      shadeSensitive: false,
      fragile: false,
      electrical: false,
      expirySensitive: false,
      regulated: false,
      brandedOrIpSensitive: false,
    },
    sources: [
      {
        kind: "AMAZON",
        url: "https://www.amazon.in/example",
      },
      {
        kind: "GOOGLE_TRENDS",
        url: "https://trends.google.com/example",
      },
      {
        kind: "SUPPLIER",
        url: "https://supplier.example/product",
      },
    ],
  };
}

function verifiedProfile() {
  return parseMarketplaceEconomicsProfileJson(
    JSON.stringify({
      schemaVersion: 1,
      profileId: "amazon-desk-2026-10",
      marketplace: "AMAZON_IN",
      categoryScope: "desk organization",
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
    }),
  );
}

test("durable demand is classified evergreen", () => {
  assert.equal(classifyDemand(candidate()), "EVERGREEN");
});

test("verified economics can produce a bounded small-stock pilot", () => {
  const item = candidate();
  const evaluation = evaluateDiscoveryCandidate(item);
  assert.equal(evaluation.recommendation, "INVESTIGATE");
  const pricing = buildResearchPricingStrategy(
    item,
    evaluation,
  );

  const strategy = buildVerifiedCommerceStrategy(
    item,
    evaluation,
    pricing,
    verifiedProfile(),
  );

  assert.equal(strategy.demandClass, "EVERGREEN");
  assert.equal(strategy.economicsStatus, "PASS");
  assert.equal(strategy.netProfitVerified, true);
  assert.equal(strategy.stockDecision, "BUY_SMALL");
  assert.ok(strategy.recommendedStockUnits > 0);
  assert.ok(
    strategy.stockCapitalPaise <= 300_000,
  );
  assert.ok((strategy.expectedNetProfitPaise ?? 0) > 0);
  assert.ok((strategy.stressNetProfitPaise ?? 0) >= 0);
  assert.ok((strategy.verifiedPricePaise ?? 0) > 0);
  assert.ok((strategy.projectedBatchProfitPaise ?? 0) > 0);
  assert.ok(strategy.reorderPointUnits >= 1);
});

test("missing verified economics never recommends buying stock", () => {
  const item = candidate();
  const evaluation = evaluateDiscoveryCandidate(item);
  const pricing = buildResearchPricingStrategy(
    item,
    evaluation,
  );

  const strategy = buildVerifiedCommerceStrategy(
    item,
    evaluation,
    pricing,
    null,
  );

  assert.equal(strategy.stockDecision, "WATCH");
  assert.equal(strategy.recommendedStockUnits, 0);
  assert.equal(strategy.netProfitVerified, false);
  assert.ok(
    strategy.economicsReasons.includes(
      "VERIFIED_ECONOMICS_PROFILE_MISSING",
    ),
  );
});

test("research rejection always blocks stock even with a verified profile", () => {
  const item: DiscoveryCandidate = {
    ...candidate(),
    risk: {
      ...candidate().risk,
      fragile: true,
    },
  };
  const evaluation = evaluateDiscoveryCandidate(item);
  const pricing = buildResearchPricingStrategy(
    item,
    evaluation,
  );

  const strategy = buildVerifiedCommerceStrategy(
    item,
    evaluation,
    pricing,
    verifiedProfile(),
  );

  assert.equal(strategy.stockDecision, "DO_NOT_STOCK");
  assert.equal(strategy.recommendedStockUnits, 0);
  assert.equal(strategy.netProfitVerified, false);
});
