import { readFileSync } from "node:fs";

import { canonicalJson } from "../core/deterministic.ts";
import {
  evaluateDiscoveryCandidate,
  parseProductDiscoveryBatchJson,
} from "../research/product-discovery.ts";

const filePath = process.argv[2];
if (filePath === undefined) {
  throw new Error("Usage: discovery:evaluate <jsonPath>");
}

const batch = parseProductDiscoveryBatchJson(
  readFileSync(filePath, "utf8"),
);
const results = batch.candidates.map((candidate) =>
  evaluateDiscoveryCandidate(candidate),
);

process.stdout.write(
  `${canonicalJson({
    schemaVersion: 1,
    generatedAt: batch.generatedAt,
    transactionAuthority: false,
    results,
  })}\n`,
);
