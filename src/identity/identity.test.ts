import assert from "node:assert/strict";
import test from "node:test";

import {
  isbn10ToIsbn13,
  normalizeIdentifier,
  toGlobalTradeKey,
} from "./identifiers.ts";
import {
  classifyIdentity,
  isAutomationEligibleIdentityClass,
} from "./matcher.ts";

test("validates and normalizes known GTIN formats", () => {
  assert.deepEqual(normalizeIdentifier("GTIN8", "9638 5074"), {
    type: "GTIN8",
    value: "96385074",
    valid: true,
    reason: "VALID",
  });

  assert.deepEqual(normalizeIdentifier("GTIN12", "036000291452"), {
    type: "GTIN12",
    value: "036000291452",
    valid: true,
    reason: "VALID",
  });

  assert.deepEqual(normalizeIdentifier("GTIN13", "400-6381-333931"), {
    type: "GTIN13",
    value: "4006381333931",
    valid: true,
    reason: "VALID",
  });

  assert.deepEqual(normalizeIdentifier("GTIN14", "10012345000017"), {
    type: "GTIN14",
    value: "10012345000017",
    valid: true,
    reason: "VALID",
  });
});

test("rejects invalid GTIN check digits deterministically", () => {
  const invalid = normalizeIdentifier("GTIN13", "4006381333932");

  assert.equal(invalid.valid, false);
  assert.equal(invalid.reason, "INVALID_CHECK_DIGIT");
});

test("validates ISBN10 and maps it to the equivalent ISBN13 trade key", () => {
  const isbn10 = normalizeIdentifier("ISBN10", "0-306-40615-2");
  const isbn13 = normalizeIdentifier("ISBN13", "9780306406157");

  assert.equal(isbn10.valid, true);
  assert.equal(isbn13.valid, true);
  assert.equal(isbn10ToIsbn13(isbn10.value), "9780306406157");
  assert.equal(toGlobalTradeKey(isbn10), toGlobalTradeKey(isbn13));
});

test("rejects a 13-digit checksum-valid value that is not an ISBN13 prefix", () => {
  const value = normalizeIdentifier("ISBN13", "4006381333931");

  assert.equal(value.valid, false);
  assert.equal(value.reason, "INVALID_ISBN13_PREFIX");
});

test("classifies exact global identifier match as A", () => {
  const result = classifyIdentity(
    {
      brand: "Example",
      condition: "new",
      marketRegion: "IN",
      edition: "standard",
      packCount: 1,
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333931",
        },
      ],
    },
    {
      brand: "example",
      condition: "NEW",
      marketRegion: "in",
      edition: "Standard",
      packCount: 1,
      identifiers: [
        {
          type: "GTIN14",
          value: "04006381333931",
        },
      ],
    },
  );

  assert.equal(result.classification, "A");
  assert.deepEqual(result.reasons, ["EXACT_GLOBAL_IDENTIFIER"]);
});

test("classifies exact brand plus MPN fallback as B", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
      mpn: "ABC-123",
    },
    {
      brand: " acme ",
      mpn: "abc-123",
    },
  );

  assert.equal(result.classification, "B");
  assert.deepEqual(result.reasons, ["EXACT_BRAND_AND_MPN"]);
});

test("classifies exact brand plus model fallback as B", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
      model: "Desk Fan 20",
    },
    {
      brand: "ACME",
      model: "desk fan 20",
    },
  );

  assert.equal(result.classification, "B");
  assert.deepEqual(result.reasons, ["EXACT_BRAND_AND_MODEL"]);
});

test("classifies brand-only evidence as C and does not auto-approve it", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
      model: "Model A",
    },
    {
      brand: "Acme",
      model: "Model B",
    },
  );

  assert.equal(result.classification, "C");
  assert.deepEqual(result.reasons, ["BRAND_SUPPORT_ONLY"]);
});

test("classifies no strong evidence as D", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
    },
    {
      model: "Unknown",
    },
  );

  assert.equal(result.classification, "D");
  assert.deepEqual(result.reasons, ["NO_STRONG_IDENTITY_EVIDENCE"]);
});

test("hard-vetoes pack, condition, edition, and region contradictions", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
      condition: "new",
      marketRegion: "IN",
      edition: "2026",
      variant: "black",
      packCount: 1,
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333931",
        },
      ],
    },
    {
      brand: "Acme",
      condition: "used",
      marketRegion: "US",
      edition: "2025",
      variant: "white",
      packCount: 2,
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333931",
        },
      ],
    },
  );

  assert.equal(result.classification, "CONFLICT");
  assert.deepEqual(result.reasons, [
    "CONDITION_CONTRADICTION",
    "REGION_CONTRADICTION",
    "EDITION_CONTRADICTION",
    "VARIANT_CONTRADICTION",
    "PACK_COUNT_CONTRADICTION",
  ]);
});

test("hard-vetoes conflicting valid global identifiers", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333931",
        },
      ],
    },
    {
      brand: "Acme",
      identifiers: [
        {
          type: "GTIN12",
          value: "036000291452",
        },
      ],
    },
  );

  assert.equal(result.classification, "CONFLICT");
  assert.deepEqual(result.reasons, ["GLOBAL_IDENTIFIER_CONFLICT"]);
});

test("hard-vetoes an invalid asserted strong identifier", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
    },
    {
      brand: "Acme",
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333932",
        },
      ],
    },
  );

  assert.equal(result.classification, "CONFLICT");
  assert.ok(result.reasons.includes("INVALID_ASSERTED_IDENTIFIER"));
});

test("hard-vetoes brand contradictions even when identifiers match", () => {
  const result = classifyIdentity(
    {
      brand: "Acme",
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333931",
        },
      ],
    },
    {
      brand: "Different Brand",
      identifiers: [
        {
          type: "GTIN13",
          value: "4006381333931",
        },
      ],
    },
  );

  assert.equal(result.classification, "CONFLICT");
  assert.deepEqual(result.reasons, ["BRAND_CONTRADICTION"]);
});

test("only A and B identity classes are automation-eligible", () => {
  assert.equal(isAutomationEligibleIdentityClass("A"), true);
  assert.equal(isAutomationEligibleIdentityClass("B"), true);
  assert.equal(isAutomationEligibleIdentityClass("C"), false);
  assert.equal(isAutomationEligibleIdentityClass("D"), false);
  assert.equal(isAutomationEligibleIdentityClass("CONFLICT"), false);
});
