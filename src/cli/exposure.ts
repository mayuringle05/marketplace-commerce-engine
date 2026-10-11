import { openDatabase } from "../db/database.ts";
import {
  initializeRuntimeSafety,
  readRuntimeSafety,
  setStopNewExposure,
} from "../runtime/safety.ts";
import {
  pauseAllListingsAndConfirm,
} from "../listings/service.ts";
import { canonicalJson } from "../core/deterministic.ts";

const command = process.argv[2] ?? "status";
const path = process.argv[3] ?? "data/commerce.sqlite";
const reason = process.argv[4] ?? "OWNER_COMMAND";
const now = new Date().toISOString();

const database = openDatabase(path, {
  appliedAt: now,
});

try {
  let pausedListings = 0;

  if (command === "init") {
    initializeRuntimeSafety(database, now);
  } else if (command === "pause") {
    setStopNewExposure(database, true, reason, now);
    pausedListings = pauseAllListingsAndConfirm(database, now);
  } else if (command === "resume") {
    const unresolved = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM exceptions
          WHERE state = 'OPEN'
        `,
      )
      .get() as { count: bigint };

    if (unresolved.count !== 0n) {
      throw new Error(
        "Cannot resume new exposure while unresolved exceptions exist.",
      );
    }

    setStopNewExposure(database, false, reason, now);
  } else if (command !== "status") {
    throw new Error(
      "Usage: exposure <status|init|pause|resume> [dbPath] [reason]",
    );
  }

  process.stdout.write(
    `${canonicalJson({
      ...readRuntimeSafety(database),
      pausedListings,
    })}\n`,
  );
} finally {
  database.close();
}
