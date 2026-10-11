import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";

export interface BuyerIntentHypothesis {
  readonly hypothesisId: string;
  readonly intentId: string;
  readonly title: string;
  readonly category: string;
  readonly commercialIntentScore: number;
  readonly urgencyScore: number;
}

export interface BuyerIntentFilterBatch {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly hypotheses: readonly BuyerIntentHypothesis[];
}

export interface BuyerIntentAcceptedHypothesis
  extends BuyerIntentHypothesis {
  readonly productKey: string;
  readonly normalizedSignature: string;
  readonly deepResearchEligible: true;
  readonly transactionAuthority: false;
}

export interface BuyerIntentRejectedHypothesis
  extends BuyerIntentHypothesis {
  readonly productKey: string;
  readonly normalizedSignature: string;
  readonly deepResearchEligible: false;
  readonly blockingReason:
    | "ALREADY_LISTED"
    | "RESEARCH_COOLDOWN"
    | "DUPLICATE_IN_BATCH"
    | "BUYER_INTENT_TOO_WEAK";
  readonly transactionAuthority: false;
}

export interface BuyerIntentFilterResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly accepted: readonly BuyerIntentAcceptedHypothesis[];
  readonly rejected: readonly BuyerIntentRejectedHypothesis[];
  readonly deepResearchAuthority: false;
  readonly listingEligible: false;
  readonly transactionAuthority: false;
}

export interface DeepResearchOutcome {
  readonly candidateId: string;
  readonly title: string;
  readonly category: string;
  readonly recommendation: "INVESTIGATE" | "HOLD" | "REJECT";
}

const TITLE_NOISE = new Set([
  "a",
  "an",
  "and",
  "for",
  "generic",
  "new",
  "of",
  "the",
  "with",
]);

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireScore(
  value: unknown,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error(`${label} must be an integer from 0 to 100.`);
  }
  return value;
}

function normalizeWords(value: string): readonly string[] {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const words = ascii
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !TITLE_NOISE.has(word));

  return [...new Set(words)].sort();
}

export function canonicalResearchProductSignature(
  title: string,
  category: string,
): string {
  const titleWords = normalizeWords(title);
  const categoryWords = normalizeWords(category);

  if (titleWords.length === 0) {
    throw new Error("Research product title has no meaningful tokens.");
  }
  if (categoryWords.length === 0) {
    throw new Error("Research product category has no meaningful tokens.");
  }

  return `${categoryWords.join("-")}|${titleWords.join("-")}`;
}

export function researchProductKey(
  title: string,
  category: string,
): string {
  const signature = canonicalResearchProductSignature(
    title,
    category,
  );
  return `research_${sha256Hex(signature).slice(0, 24)}`;
}

function parseHypothesis(
  value: unknown,
  index: number,
): BuyerIntentHypothesis {
  const record = requireRecord(
    value,
    `hypotheses[${index}]`,
  );
  if (
    !exactKeys(record, [
      "hypothesisId",
      "intentId",
      "title",
      "category",
      "commercialIntentScore",
      "urgencyScore",
    ])
  ) {
    throw new Error(
      `hypotheses[${index}] does not match the exact schema.`,
    );
  }

  return {
    hypothesisId: requireString(
      record.hypothesisId,
      `hypotheses[${index}].hypothesisId`,
      160,
    ),
    intentId: requireString(
      record.intentId,
      `hypotheses[${index}].intentId`,
      160,
    ),
    title: requireString(
      record.title,
      `hypotheses[${index}].title`,
      300,
    ),
    category: requireString(
      record.category,
      `hypotheses[${index}].category`,
      160,
    ),
    commercialIntentScore: requireScore(
      record.commercialIntentScore,
      `hypotheses[${index}].commercialIntentScore`,
    ),
    urgencyScore: requireScore(
      record.urgencyScore,
      `hypotheses[${index}].urgencyScore`,
    ),
  };
}

export function parseBuyerIntentFilterBatchJson(
  json: string,
): BuyerIntentFilterBatch {
  if (Buffer.byteLength(json, "utf8") > 256 * 1024) {
    throw new Error("Buyer-intent batch exceeds 256 KiB.");
  }

  const record = requireRecord(
    JSON.parse(json) as unknown,
    "buyer-intent batch",
  );
  if (
    !exactKeys(record, [
      "schemaVersion",
      "generatedAt",
      "hypotheses",
    ]) ||
    record.schemaVersion !== 1 ||
    typeof record.generatedAt !== "string" ||
    !Array.isArray(record.hypotheses) ||
    record.hypotheses.length === 0 ||
    record.hypotheses.length > 100
  ) {
    throw new Error(
      "Buyer-intent batch does not match exact schema version 1.",
    );
  }

  assertCanonicalUtcTimestamp(
    record.generatedAt,
    "generatedAt",
  );

  const hypotheses = record.hypotheses.map(parseHypothesis);
  const ids = new Set<string>();
  for (const hypothesis of hypotheses) {
    if (ids.has(hypothesis.hypothesisId)) {
      throw new Error(
        `Duplicate hypothesisId: ${hypothesis.hypothesisId}`,
      );
    }
    ids.add(hypothesis.hypothesisId);
  }

  return {
    schemaVersion: 1,
    generatedAt: record.generatedAt,
    hypotheses,
  };
}

interface ResearchSubjectRow {
  readonly lifecycle_state: string;
  readonly last_deep_researched_at: string | null;
}

function currentListingKeys(
  database: DatabaseSync,
): ReadonlySet<string> {
  const rows = database
    .prepare(
      `
        SELECT DISTINCT p.research_product_key AS product_key
        FROM listings l
        JOIN marketplace_catalogue_items m
          ON m.id = l.marketplace_catalogue_item_id
        JOIN packaged_trade_units t
          ON t.id = m.trade_unit_id
        JOIN products p
          ON p.id = t.product_id
        WHERE p.research_product_key IS NOT NULL
      `,
    )
    .all() as unknown as Array<{
    product_key: string;
  }>;

  const listedSubjects = database
    .prepare(
      `
        SELECT product_key
        FROM research_subjects
        WHERE lifecycle_state = 'LISTED'
      `,
    )
    .all() as unknown as Array<{
    product_key: string;
  }>;

  return new Set(
    [...rows, ...listedSubjects].map(
      (row) => row.product_key,
    ),
  );
}

function upsertIntentCandidate(
  database: DatabaseSync,
  hypothesis: BuyerIntentHypothesis,
  productKey: string,
  signature: string,
  seenAt: string,
): void {
  database
    .prepare(
      `
        INSERT INTO research_subjects (
          product_key,
          normalized_signature,
          generic_title,
          category,
          lifecycle_state,
          first_seen_at,
          last_seen_at,
          last_deep_researched_at,
          listed_at,
          last_candidate_id
        ) VALUES (
          ?, ?, ?, ?, 'INTENT_CANDIDATE',
          ?, ?, NULL, NULL, ?
        )
        ON CONFLICT(product_key) DO UPDATE SET
          generic_title = excluded.generic_title,
          category = excluded.category,
          last_seen_at = excluded.last_seen_at,
          last_candidate_id = excluded.last_candidate_id
      `,
    )
    .run(
      productKey,
      signature,
      hypothesis.title,
      hypothesis.category,
      seenAt,
      seenAt,
      hypothesis.hypothesisId,
    );
}

export function filterBuyerIntentHypotheses(
  database: DatabaseSync,
  batch: BuyerIntentFilterBatch,
  evaluatedAt: string,
  cooldownDays = 30,
): BuyerIntentFilterResult {
  const evaluatedMs = assertCanonicalUtcTimestamp(
    evaluatedAt,
    "evaluatedAt",
  );
  if (
    !Number.isSafeInteger(cooldownDays) ||
    cooldownDays < 1 ||
    cooldownDays > 365
  ) {
    throw new Error(
      "cooldownDays must be an integer from 1 to 365.",
    );
  }

  const listedKeys = currentListingKeys(database);
  const accepted: BuyerIntentAcceptedHypothesis[] = [];
  const rejected: BuyerIntentRejectedHypothesis[] = [];
  const seenThisBatch = new Set<string>();
  const cooldownMs =
    cooldownDays * 24 * 60 * 60 * 1_000;

  const readSubject = database.prepare(
    `
      SELECT lifecycle_state, last_deep_researched_at
      FROM research_subjects
      WHERE product_key = ?
    `,
  );

  for (const hypothesis of batch.hypotheses) {
    const normalizedSignature =
      canonicalResearchProductSignature(
        hypothesis.title,
        hypothesis.category,
      );
    const productKey = researchProductKey(
      hypothesis.title,
      hypothesis.category,
    );

    let blockingReason:
      | BuyerIntentRejectedHypothesis["blockingReason"]
      | null = null;

    if (seenThisBatch.has(productKey)) {
      blockingReason = "DUPLICATE_IN_BATCH";
    } else if (
      hypothesis.commercialIntentScore < 65 ||
      hypothesis.urgencyScore < 35
    ) {
      blockingReason = "BUYER_INTENT_TOO_WEAK";
    } else if (listedKeys.has(productKey)) {
      blockingReason = "ALREADY_LISTED";
    } else {
      const subject = readSubject.get(
        productKey,
      ) as ResearchSubjectRow | undefined;

      if (subject?.lifecycle_state === "LISTED") {
        blockingReason = "ALREADY_LISTED";
      } else if (
        subject?.last_deep_researched_at !== null &&
        subject?.last_deep_researched_at !== undefined
      ) {
        const researchedMs = assertCanonicalUtcTimestamp(
          subject.last_deep_researched_at,
          "last_deep_researched_at",
        );
        if (
          evaluatedMs >= researchedMs &&
          evaluatedMs - researchedMs < cooldownMs
        ) {
          blockingReason = "RESEARCH_COOLDOWN";
        }
      }
    }

    seenThisBatch.add(productKey);
    upsertIntentCandidate(
      database,
      hypothesis,
      productKey,
      normalizedSignature,
      evaluatedAt,
    );

    if (blockingReason !== null) {
      rejected.push({
        ...hypothesis,
        productKey,
        normalizedSignature,
        deepResearchEligible: false,
        blockingReason,
        transactionAuthority: false,
      });
    } else {
      accepted.push({
        ...hypothesis,
        productKey,
        normalizedSignature,
        deepResearchEligible: true,
        transactionAuthority: false,
      });
    }
  }

  const inputHash = sha256Hex(
    JSON.stringify({
      generatedAt: batch.generatedAt,
      hypotheses: batch.hypotheses,
    }),
  );
  database
    .prepare(
      `
        INSERT OR IGNORE INTO buyer_intent_runs (
          id,
          generated_at,
          input_hash,
          hypothesis_count,
          accepted_count,
          rejected_count,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      deterministicId(
        "intent_run",
        inputHash,
      ),
      batch.generatedAt,
      inputHash,
      batch.hypotheses.length,
      accepted.length,
      rejected.length,
      evaluatedAt,
    );

  return {
    schemaVersion: 1,
    generatedAt: batch.generatedAt,
    accepted,
    rejected,
    deepResearchAuthority: false,
    listingEligible: false,
    transactionAuthority: false,
  };
}

export function recordDeepResearchOutcome(
  database: DatabaseSync,
  outcome: DeepResearchOutcome,
  recordedAt: string,
): string {
  assertCanonicalUtcTimestamp(recordedAt, "recordedAt");
  const productKey = researchProductKey(
    outcome.title,
    outcome.category,
  );
  const signature = canonicalResearchProductSignature(
    outcome.title,
    outcome.category,
  );

  database
    .prepare(
      `
        INSERT INTO research_subjects (
          product_key,
          normalized_signature,
          generic_title,
          category,
          lifecycle_state,
          first_seen_at,
          last_seen_at,
          last_deep_researched_at,
          listed_at,
          last_candidate_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
        )
        ON CONFLICT(product_key) DO UPDATE SET
          generic_title = excluded.generic_title,
          category = excluded.category,
          lifecycle_state = CASE
            WHEN research_subjects.lifecycle_state = 'LISTED'
              THEN 'LISTED'
            ELSE excluded.lifecycle_state
          END,
          last_seen_at = excluded.last_seen_at,
          last_deep_researched_at =
            excluded.last_deep_researched_at,
          last_candidate_id = excluded.last_candidate_id
      `,
    )
    .run(
      productKey,
      signature,
      outcome.title,
      outcome.category,
      outcome.recommendation,
      recordedAt,
      recordedAt,
      recordedAt,
      outcome.candidateId,
    );

  return productKey;
}

export function markResearchSubjectListed(
  database: DatabaseSync,
  input: {
    readonly productId: string;
    readonly productKey: string;
    readonly listedAt: string;
  },
): void {
  assertCanonicalUtcTimestamp(input.listedAt, "listedAt");

  const subject = database
    .prepare(
      `
        SELECT product_key
        FROM research_subjects
        WHERE product_key = ?
      `,
    )
    .get(input.productKey);

  if (subject === undefined) {
    throw new Error(
      "Cannot mark an unknown research subject as listed.",
    );
  }

  const product = database
    .prepare(
      "SELECT id FROM products WHERE id = ?",
    )
    .get(input.productId);
  if (product === undefined) {
    throw new Error("Cannot link listing to unknown product.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE products
          SET
            research_product_key = ?,
            generic_title = (
              SELECT generic_title
              FROM research_subjects
              WHERE product_key = ?
            ),
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        input.productKey,
        input.productKey,
        input.listedAt,
        input.productId,
      );

    database
      .prepare(
        `
          UPDATE research_subjects
          SET
            lifecycle_state = 'LISTED',
            listed_at = ?,
            last_seen_at = ?
          WHERE product_key = ?
        `,
      )
      .run(
        input.listedAt,
        input.listedAt,
        input.productKey,
      );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
