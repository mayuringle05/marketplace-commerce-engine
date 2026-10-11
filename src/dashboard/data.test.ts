import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  filterBuyerIntentHypotheses,
  recordDeepResearchOutcome,
} from "../research/buyer-intent.ts";
import {
  evaluateDiscoveryCandidate,
  type DiscoveryCandidate,
} from "../research/product-discovery.ts";
import {
  buildResearchPricingStrategy,
} from "../research/pricing-strategy.ts";
import {
  persistResearchEvaluation,
} from "../research/research-store.ts";
import { loadCommerceDashboardSnapshot } from "./data.ts";

const GENERATED_AT = "2026-10-11T10:00:00.000Z";
const RECORDED_AT = "2026-10-11T10:05:00.000Z";

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

test("dashboard snapshot exposes persisted intent, research, evidence and pricing", () => {
  const database = openDatabase(":memory:", {
    appliedAt: GENERATED_AT,
  });

  try {
    const intent = filterBuyerIntentHypotheses(
      database,
      {
        schemaVersion: 1,
        generatedAt: GENERATED_AT,
        hypotheses: [
          {
            hypothesisId: "desk-organizer-hypothesis",
            intentId: "home-office-organization",
            title: "Compact desk organizer tray",
            category: "desk organization",
            commercialIntentScore: 88,
            urgencyScore: 71,
          },
        ],
      },
      GENERATED_AT,
    );
    const accepted = intent.accepted[0];
    assert.ok(accepted);

    const item = candidate();
    const evaluation = evaluateDiscoveryCandidate(item);
    const pricing = buildResearchPricingStrategy(
      item,
      evaluation,
    );
    const productKey = recordDeepResearchOutcome(
      database,
      {
        candidateId: item.candidateId,
        title: item.title,
        category: item.category,
        recommendation: evaluation.recommendation,
      },
      RECORDED_AT,
    );

    assert.equal(productKey, accepted.productKey);

    persistResearchEvaluation(
      database,
      {
        productKey,
        generatedAt: GENERATED_AT,
        recordedAt: RECORDED_AT,
        candidate: item,
        evaluation,
        pricing,
      },
    );

    const snapshot = loadCommerceDashboardSnapshot(database);
    assert.equal(snapshot.summary.totalProducts, 1);
    assert.equal(snapshot.summary.evaluatedProducts, 1);
    assert.equal(snapshot.summary.investigate, 1);

    const product = snapshot.products[0];
    assert.ok(product);
    assert.equal(product.commercialIntentScore, 88);
    assert.equal(product.urgencyScore, 71);
    assert.equal(product.intentId, "home-office-organization");
    assert.equal(
      product.evaluation?.recommendation,
      "INVESTIGATE",
    );
    assert.equal(
      product.evaluation?.pricingStrategy,
      "MARGIN_FIRST",
    );
    assert.ok(
      (product.evaluation?.suggestedPricePaise ?? 0) > 0,
    );
    assert.equal(product.evaluation?.sources.length, 3);
    assert.equal(product.evaluation?.netProfitVerified, false);
  } finally {
    database.close();
  }
});
