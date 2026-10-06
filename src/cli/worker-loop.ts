import { setTimeout as sleep } from "node:timers/promises";

import { openDatabase } from "../db/database.ts";
import { initializeRuntimeSafety } from "../runtime/safety.ts";
import { runWorkerOnce } from "../runtime/worker.ts";

const path = process.argv[2] ?? "data/commerce.sqlite";
const database = openDatabase(path, {
  appliedAt: new Date().toISOString(),
});

initializeRuntimeSafety(database, new Date().toISOString());

let stopping = false;
const stop = () => {
  stopping = true;
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  while (!stopping) {
    const asOf = new Date().toISOString();
    const leaseUntil = new Date(
      Date.now() + 60_000,
    ).toISOString();

    const ran = runWorkerOnce(
      database,
      `worker-${process.pid}`,
      asOf,
      leaseUntil,
    );

    if (!ran) {
      await sleep(5_000);
    }
  }
} finally {
  database.close();
}
