import { rmSync } from "node:fs";

import { openDatabase } from "../db/database.ts";
import { runLocalEndToEndDemo } from "../simulation/e2e-demo.ts";
import { canonicalJson } from "../core/deterministic.ts";

const path = process.argv[2] ?? "data/e2e-demo.sqlite";

rmSync(path, { force: true });
rmSync(`${path}-wal`, { force: true });
rmSync(`${path}-shm`, { force: true });

const database = openDatabase(path, {
  appliedAt: "2026-10-07T00:00:00.000Z",
});

try {
  const summary = runLocalEndToEndDemo(database);
  process.stdout.write(
    `${canonicalJson({
      database: path,
      ...summary,
      listingQuantity: summary.listingQuantity.toString(),
      recognizedProfitPaise:
        summary.recognizedProfitPaise.toString(),
      auditEventCount: summary.auditEventCount.toString(),
    })}\n`,
  );
} finally {
  database.close();
}
