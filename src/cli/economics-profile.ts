import { readFileSync } from "node:fs";

import { canonicalJson } from "../core/deterministic.ts";
import { openDatabase } from "../db/database.ts";
import {
  parseMarketplaceEconomicsProfileJson,
  upsertMarketplaceEconomicsProfile,
} from "../research/economics-profile.ts";
import {
  recomputeStoredResearchStrategies,
} from "../research/recompute-strategy.ts";

const profilePath = process.argv[2];
const dbPath = process.argv[3] ?? "data/commerce.sqlite";

if (profilePath === undefined) {
  throw new Error(
    "Usage: economics-profile:import <profile.json> [dbPath]",
  );
}

const profile = parseMarketplaceEconomicsProfileJson(
  readFileSync(profilePath, "utf8"),
);
const now = new Date().toISOString();
const database = openDatabase(dbPath, {
  appliedAt: now,
});

try {
  upsertMarketplaceEconomicsProfile(
    database,
    profile,
    now,
  );
  const recomputed = recomputeStoredResearchStrategies(
    database,
    now,
  );

  process.stdout.write(
    `${canonicalJson({
      schemaVersion: 1,
      profileId: profile.profileId,
      marketplace: profile.marketplace,
      categoryScope: profile.categoryScope,
      recomputedResearchRows: recomputed,
      transactionAuthority: false,
    })}\n`,
  );
} finally {
  database.close();
}
