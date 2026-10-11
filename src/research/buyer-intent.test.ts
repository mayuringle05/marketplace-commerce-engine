import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  canonicalResearchProductSignature,
  filterBuyerIntentHypotheses,
  markResearchSubjectListed,
  parseBuyerIntentFilterBatchJson,
  recordDeepResearchOutcome,
  researchProductKey,
} from "./buyer-intent.ts";

const T0 = "2026-10-11T10:00:00.000Z";

function batch(
  overrides: Partial<{
    title: string;
    category: string;
    commercialIntentScore: number;
    urgencyScore: number;
  }> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: T0,
    hypotheses: [
      {
        hypothesisId: "hypothesis-1",
        intentId: "intent-1",
        title: overrides.title ?? "Generic desk cable organizer",
        category: overrides.category ?? "desk organization",
        commercialIntentScore:
          overrides.commercialIntentScore ?? 84,
        urgencyScore: overrides.urgencyScore ?? 71,
      },
    ],
  });
}

test("product signatures are deterministic and ignore word order/noise", () => {
  const left = canonicalResearchProductSignature(
    "Generic desk cable organizer",
    "Desk Organization",
  );
  const right = canonicalResearchProductSignature(
    "Cable organizer for the desk",
    "desk organization",
  );

  assert.equal(left, right);
  assert.equal(
    researchProductKey(
      "Generic desk cable organizer",
      "Desk Organization",
    ),
    researchProductKey(
      "Cable organizer for the desk",
      "desk organization",
    ),
  );
});

test("strong buyer intent is eligible once, then deep research enters cooldown", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const parsed = parseBuyerIntentFilterBatchJson(batch());
    const first = filterBuyerIntentHypotheses(
      database,
      parsed,
      "2026-10-11T10:01:00.000Z",
      30,
    );

    assert.equal(first.accepted.length, 1);
    assert.equal(first.rejected.length, 0);
    assert.equal(first.transactionAuthority, false);
    assert.equal(first.listingEligible, false);

    recordDeepResearchOutcome(
      database,
      {
        candidateId: "candidate-1",
        title: "Generic desk cable organizer",
        category: "desk organization",
        recommendation: "INVESTIGATE",
      },
      "2026-10-11T10:10:00.000Z",
    );

    const second = filterBuyerIntentHypotheses(
      database,
      parsed,
      "2026-10-12T10:00:00.000Z",
      30,
    );

    assert.equal(second.accepted.length, 0);
    assert.equal(second.rejected.length, 1);
    assert.equal(
      second.rejected[0]?.blockingReason,
      "RESEARCH_COOLDOWN",
    );

    const afterCooldown = filterBuyerIntentHypotheses(
      database,
      parsed,
      "2026-11-11T10:11:00.000Z",
      30,
    );

    assert.equal(afterCooldown.accepted.length, 1);
    assert.equal(afterCooldown.rejected.length, 0);
  } finally {
    database.close();
  }
});

test("listed subjects are permanently excluded from deep research", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
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
          ) VALUES (
            'product-1',
            'Generic',
            'Supplier',
            'Cable Organizer',
            'CO-1',
            'new',
            'IN',
            ?,
            ?
          )
        `,
      )
      .run(T0, T0);

    const parsed = parseBuyerIntentFilterBatchJson(batch());
    const initial = filterBuyerIntentHypotheses(
      database,
      parsed,
      "2026-10-11T10:01:00.000Z",
    );
    const accepted = initial.accepted[0];
    assert.ok(accepted);

    markResearchSubjectListed(database, {
      productId: "product-1",
      productKey: accepted.productKey,
      listedAt: "2026-10-11T10:30:00.000Z",
    });

    const muchLater = filterBuyerIntentHypotheses(
      database,
      parsed,
      "2027-10-11T10:31:00.000Z",
      30,
    );

    assert.equal(muchLater.accepted.length, 0);
    assert.equal(
      muchLater.rejected[0]?.blockingReason,
      "ALREADY_LISTED",
    );

    const product = database
      .prepare(
        `
          SELECT research_product_key, generic_title
          FROM products
          WHERE id = 'product-1'
        `,
      )
      .get() as {
      research_product_key: string;
      generic_title: string;
    };

    assert.equal(
      product.research_product_key,
      accepted.productKey,
    );
    assert.equal(
      product.generic_title,
      "Generic desk cable organizer",
    );
  } finally {
    database.close();
  }
});

test("weak buyer intent and duplicate product hypotheses never reach deep research", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const weak = parseBuyerIntentFilterBatchJson(
      batch({
        commercialIntentScore: 40,
        urgencyScore: 20,
      }),
    );
    const weakResult = filterBuyerIntentHypotheses(
      database,
      weak,
      "2026-10-11T10:01:00.000Z",
    );

    assert.equal(weakResult.accepted.length, 0);
    assert.equal(
      weakResult.rejected[0]?.blockingReason,
      "BUYER_INTENT_TOO_WEAK",
    );

    const duplicate = parseBuyerIntentFilterBatchJson(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: T0,
        hypotheses: [
          {
            hypothesisId: "hypothesis-a",
            intentId: "intent-a",
            title: "Desk cable organizer",
            category: "desk organization",
            commercialIntentScore: 90,
            urgencyScore: 80,
          },
          {
            hypothesisId: "hypothesis-b",
            intentId: "intent-b",
            title: "Cable organizer for the desk",
            category: "desk organization",
            commercialIntentScore: 88,
            urgencyScore: 76,
          },
        ],
      }),
    );
    const duplicateResult = filterBuyerIntentHypotheses(
      database,
      duplicate,
      "2026-10-11T10:02:00.000Z",
    );

    assert.equal(duplicateResult.accepted.length, 1);
    assert.equal(duplicateResult.rejected.length, 1);
    assert.equal(
      duplicateResult.rejected[0]?.blockingReason,
      "DUPLICATE_IN_BATCH",
    );
  } finally {
    database.close();
  }
});
