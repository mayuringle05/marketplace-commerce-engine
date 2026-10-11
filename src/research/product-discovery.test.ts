import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDiscoveryCandidate,
  parseProductDiscoveryBatchJson,
} from "./product-discovery.ts";

function candidate(
  riskOverrides: Partial<{
    sizeDependent: boolean;
    fitSensitive: boolean;
    shadeSensitive: boolean;
    fragile: boolean;
    electrical: boolean;
    expirySensitive: boolean;
    regulated: boolean;
    brandedOrIpSensitive: boolean;
  }> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    candidates: [
      {
        candidateId: "desk-cable-organizer-1",
        title: "Generic desk cable organizer",
        marketplace: "AMAZON_IN",
        category: "desk organization",
        expectedSellPricePaise: 49_900,
        estimatedSupplierCostPaise: 18_000,
        competitionScore: 28,
        trendConfidence: 82,
        demand: {
          reactive: 78,
          predictive: 88,
          structural: 75,
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
          ...riskOverrides,
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
  });
}

test("research-only discovery evaluator promotes a strong low-risk candidate to investigate", () => {
  const batch = parseProductDiscoveryBatchJson(candidate());
  const first = batch.candidates[0];
  assert.ok(first);

  const decision = evaluateDiscoveryCandidate(first);

  assert.equal(decision.recommendation, "INVESTIGATE");
  assert.equal(decision.listingEligible, false);
  assert.equal(decision.transactionAuthority, false);
  assert.deepEqual(decision.blockingReasons, []);
  assert.ok(decision.demandScore >= 60);
  assert.ok(decision.estimatedGrossSpreadBps >= 2_500);
});

test("size-dependent products are rejected even with strong demand and spread", () => {
  const batch = parseProductDiscoveryBatchJson(
    candidate({ sizeDependent: true }),
  );
  const first = batch.candidates[0];
  assert.ok(first);

  const decision = evaluateDiscoveryCandidate(first);

  assert.equal(decision.recommendation, "REJECT");
  assert.ok(decision.blockingReasons.includes("SIZE_DEPENDENT"));
  assert.equal(decision.transactionAuthority, false);
});

test("discovery input requires exact schema and HTTPS evidence", () => {
  const invalid = JSON.parse(candidate()) as {
    candidates: Array<Record<string, unknown>>;
  };
  const first = invalid.candidates[0];
  assert.ok(first);
  first.unexpected = true;

  assert.throws(
    () => parseProductDiscoveryBatchJson(JSON.stringify(invalid)),
    /does not match the exact schema/,
  );

  delete first.unexpected;
  const sources = first.sources as Array<Record<string, unknown>>;
  const source = sources[0];
  assert.ok(source);
  source.url = "http://example.test";

  assert.throws(
    () => parseProductDiscoveryBatchJson(JSON.stringify(invalid)),
    /must use HTTPS/,
  );
});
