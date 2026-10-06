import { openDatabase } from "../db/database.ts";
import {
  initializeRuntimeSafety,
  readRuntimeSafety,
  setStopNewExposure,
} from "../runtime/safety.ts";
import { canonicalJson } from "../core/deterministic.ts";

const command = process.argv[2] ?? "status";
const path = process.argv[3] ?? "data/commerce.sqlite";
const reason = process.argv[4] ?? "OWNER_COMMAND";
const now = new Date().toISOString();

const database = openDatabase(path, {
  appliedAt: now,
});

try {
  if (command === "init") {
    initializeRuntimeSafety(database, now);
  } else if (command === "pause") {
    setStopNewExposure(database, true, reason, now);
  } else if (command === "resume") {
    setStopNewExposure(database, false, reason, now);
  } else if (command !== "status") {
    throw new Error(
      "Usage: exposure <status|init|pause|resume> [dbPath] [reason]",
    );
  }

  process.stdout.write(
    `${canonicalJson(readRuntimeSafety(database))}\n`,
  );
} finally {
  database.close();
}
