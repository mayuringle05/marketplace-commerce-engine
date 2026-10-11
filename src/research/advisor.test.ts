import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  filterBuyerIntentHypotheses,
  recordDeepResearchOutcome,
} from "./buyer-intent.ts";
import {
  buildCommerceAdvisorPacket,
  persistCommerceAdvice,
  validateCommerceAdvicePack,
} from "./advisor.ts";
import {
  evaluateDiscoveryCandidate,
  type DiscoveryCandidate,
} from "./product-discovery.ts";
import {
  buildResearchPricingStrategy,
} from "./pricing-strategy.ts";
import {
  persistResearchEvaluation,
} from "./research-store.ts";
import {
  buildVerifiedCommerceStrategy,
} from "./verified-strategy.ts";

const GENERATED_AT = "2026-10-11T10:00:00.000Z";
const RECORDED_AT = "2026-10-11T10:05:00.000Z";
const ADVICE_AT = "2026-10-11T10:10:00.000Z";

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

function seedEvaluation(database: ReturnType<typeof openDatabase>): string {
  const filtered = filterBuyerIntentHypotheses(
    database,
    {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      hypotheses: [
        {
          hypothesisId: "desk-organizer-hypothesis",
          intentId: "desk-organization-intent",
          title: "Compact desk organizer tray",
          category: "desk organization",
          commercialIntentScore: 88,
          urgencyScore: 64,
        },
      ],
    },
    GENERATED_AT,
  );
  const accepted = filtered.accepted[0];
  assert.ok(accepted);

  const item = candidate();
  const evaluation = evaluateDiscoveryCandidate(item);
  const pricing = buildResearchPricingStrategy(item, evaluation);
  const verifiedStrategy = buildVerifiedCommerceStrategy(
    item,
    evaluation,
    pricing,
    null,
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
      verifiedStrategy,
    },
  );
  return productKey;
}

test("advisor packet is deterministic-bound and transaction powerless", () => {
  const database = openDatabase(":memory:", {
    appliedAt: GENERATED_AT,
  });

  try {
    const productKey = seedEvaluation(database);
    const packet = buildCommerceAdvisorPacket(
      database,
      {
        schemaVersion: 1,
        productKeys: [productKey],
      },
      ADVICE_AT,
    );

    assert.equal(packet.facts.length, 1);
    assert.equal(packet.transactionAuthority, false);
    assert.equal(packet.supplierContactAuthority, false);
    assert.equal(packet.facts[0]?.productKey, productKey);
    assert.equal(packet.facts[0]?.inputHash.length, 64);

    const fact = packet.facts[0];
    assert.ok(fact);

    const advice = validateCommerceAdvicePack(
      {
        schemaVersion: 1,
        generatedAt: ADVICE_AT,
        transactionAuthority: false,
        supplierContactAuthority: false,
        advice: [
          {
            productKey: fact.productKey,
            evaluationId: fact.evaluationId,
            inputHash: fact.inputHash,
            headline: "Promising demand, but economics still need verification.",
            explanation:
              "Demand and competition look favorable, while verified net economics are still unavailable.",
            recommendedStrategy: [
              "Verify marketplace fees and logistics before committing stock.",
              "Confirm the supplier quote and invoice support.",
            ],
            supplierNegotiation: {
              shouldNegotiate: true,
              objective:
                "Improve landed unit economics without increasing MOQ risk.",
              openingMessage:
                "We are evaluating a small pilot order. Please share your best unit price, MOQ, GST invoice terms, shipping cost, and price breaks for repeat orders.",
              followUps: [
                "Ask for a lower MOQ before trading margin for volume.",
              ],
              asks: [
                "Best unit price",
                "MOQ",
                "GST invoice",
                "Shipping",
              ],
              cautions: [
                "Do not commit to volume before economics are verified.",
              ],
            },
          },
        ],
      },
      packet,
    );

    assert.equal(persistCommerceAdvice(database, advice), 1);

    const row = database
      .prepare(
        "SELECT headline, transaction_authority, supplier_contact_authority FROM research_advice",
      )
      .get() as {
        headline: string;
        transaction_authority: bigint;
        supplier_contact_authority: bigint;
      };

    assert.match(row.headline, /Promising demand/);
    assert.equal(row.transaction_authority, 0n);
    assert.equal(row.supplier_contact_authority, 0n);

    assert.throws(
      () =>
        validateCommerceAdvicePack(
          {
            ...advice,
            advice: [
              {
                ...advice.advice[0],
                inputHash: "0".repeat(64),
              },
            ],
          },
          packet,
        ),
      /not bound to the deterministic input/,
    );
  } finally {
    database.close();
  }
});
