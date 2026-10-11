import { readFileSync } from "node:fs";

import { canonicalJson } from "../core/deterministic.ts";
import { openDatabase } from "../db/database.ts";
import {
  filterBuyerIntentHypotheses,
  markResearchSubjectListed,
  parseBuyerIntentFilterBatchJson,
} from "../research/buyer-intent.ts";

const command = process.argv[2];

if (command === "filter") {
  const filePath = process.argv[3];
  const dbPath = process.argv[4] ?? "data/commerce.sqlite";
  const cooldownDays = Number(process.argv[5] ?? "30");

  if (filePath === undefined) {
    throw new Error(
      "Usage: buyer-intent filter <jsonPath> [dbPath] [cooldownDays]",
    );
  }

  const now = new Date().toISOString();
  const database = openDatabase(dbPath, {
    appliedAt: now,
  });

  try {
    const batch = parseBuyerIntentFilterBatchJson(
      readFileSync(filePath, "utf8"),
    );
    const result = filterBuyerIntentHypotheses(
      database,
      batch,
      now,
      cooldownDays,
    );
    process.stdout.write(
      `${canonicalJson(result)}\n`,
    );
  } finally {
    database.close();
  }
} else if (command === "mark-listed") {
  const productId = process.argv[3];
  const productKey = process.argv[4];
  const dbPath = process.argv[5] ?? "data/commerce.sqlite";

  if (
    productId === undefined ||
    productKey === undefined
  ) {
    throw new Error(
      "Usage: buyer-intent mark-listed <productId> <productKey> [dbPath]",
    );
  }

  const now = new Date().toISOString();
  const database = openDatabase(dbPath, {
    appliedAt: now,
  });

  try {
    markResearchSubjectListed(database, {
      productId,
      productKey,
      listedAt: now,
    });
    process.stdout.write(
      `${canonicalJson({
        productId,
        productKey,
        lifecycleState: "LISTED",
        transactionAuthority: false,
      })}\n`,
    );
  } finally {
    database.close();
  }
} else {
  throw new Error(
    "Usage: buyer-intent <filter|mark-listed> ...",
  );
}
