import { readFileSync } from "node:fs";

import { canonicalJson } from "../core/deterministic.ts";
import { openDatabase } from "../db/database.ts";
import {
  recordDeepResearchOutcome,
} from "../research/buyer-intent.ts";
import {
  evaluateDiscoveryCandidate,
  parseProductDiscoveryBatchJson,
} from "../research/product-discovery.ts";

const filePath = process.argv[2];
const dbPath = process.argv[3];

if (filePath === undefined) {
  throw new Error(
    "Usage: discovery:evaluate <jsonPath> [dbPath]",
  );
}

const batch = parseProductDiscoveryBatchJson(
  readFileSync(filePath, "utf8"),
);
const results = batch.candidates.map((candidate) =>
  evaluateDiscoveryCandidate(candidate),
);

if (dbPath !== undefined) {
  const now = new Date().toISOString();
  const database = openDatabase(dbPath, {
    appliedAt: now,
  });

  try {
    for (let index = 0; index < batch.candidates.length; index += 1) {
      const candidate = batch.candidates[index];
      const result = results[index];
      if (candidate === undefined || result === undefined) {
        throw new Error(
          "Discovery result/candidate cardinality mismatch.",
        );
      }
      recordDeepResearchOutcome(
        database,
        {
          candidateId: candidate.candidateId,
          title: candidate.title,
          category: candidate.category,
          recommendation: result.recommendation,
        },
        now,
      );
    }
  } finally {
    database.close();
  }
}

process.stdout.write(
  `${canonicalJson({
    schemaVersion: 1,
    generatedAt: batch.generatedAt,
    transactionAuthority: false,
    results,
  })}\n`,
);
