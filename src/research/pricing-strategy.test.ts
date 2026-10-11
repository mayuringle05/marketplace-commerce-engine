import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDiscoveryCandidate,
  parseProductDiscoveryBatchJson,
} from "./product-discovery.ts";
import {
  buildResearchPricingStrategy,
} from "./pricing-strategy.ts";

function strongCandidate() {
  const batch = parseProductDiscoveryBatchJson(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-11T10:00:00.000Z",
      candidates: [
        {
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
        },
      ],
    }),
  );
  const candidate = batch.candidates[0];
  assert.ok(candidate);
  return candidate;
}

test("pricing strategy recommends a bounded gross price for actionable research", () => {
  const candidate = strongCandidate();
  const evaluation = evaluateDiscoveryCandidate(candidate);
  assert.equal(evaluation.recommendation, "INVESTIGATE");

  const pricing = buildResearchPricingStrategy(
    candidate,
    evaluation,
  );

  assert.equal(pricing.strategy, "MARGIN_FIRST");
  assert.ok(pricing.suggestedFloorPricePaise !== null);
  assert.ok(pricing.suggestedPricePaise !== null);
  assert.ok(pricing.suggestedCeilingPricePaise !== null);
  assert.ok(
    pricing.suggestedPricePaise >=
      pricing.suggestedFloorPricePaise,
  );
  assert.ok(
    pricing.suggestedPricePaise <=
      pricing.suggestedCeilingPricePaise,
  );
  assert.ok(
    pricing.suggestedPricePaise >
      candidate.estimatedSupplierCostPaise,
  );
  assert.ok(
    (pricing.estimatedGrossMarginBps ?? 0) >= 2_500,
  );
  assert.equal(pricing.netProfitVerified, false);
});

test("rejected research never receives an actionable suggested price", () => {
  const candidate = {
    ...strongCandidate(),
    risk: {
      ...strongCandidate().risk,
      fragile: true,
    },
  };
  const evaluation = evaluateDiscoveryCandidate(candidate);
  assert.equal(evaluation.recommendation, "REJECT");

  const pricing = buildResearchPricingStrategy(
    candidate,
    evaluation,
  );

  assert.equal(pricing.strategy, "BLOCKED");
  assert.equal(pricing.suggestedPricePaise, null);
  assert.equal(pricing.estimatedGrossProfitPaise, null);
  assert.equal(pricing.netProfitVerified, false);
});
