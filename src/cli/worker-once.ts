import { openDatabase } from "../db/database.ts";
import { runWorkerOnce } from "../runtime/worker.ts";
import { canonicalJson } from "../core/deterministic.ts";

const path = process.argv[2] ?? "data/commerce.sqlite";
const asOf = process.argv[3] ?? new Date().toISOString();
const leaseUntil =
  process.argv[4] ??
  new Date(new Date(asOf).getTime() + 60_000).toISOString();

const database = openDatabase(path, {
  appliedAt: asOf,
});

try {
  const ran = runWorkerOnce(
    database,
    `worker-${process.pid}`,
    asOf,
    leaseUntil,
  );

  process.stdout.write(
    `${canonicalJson({ ran, asOf, leaseUntil })}\n`,
  );
} finally {
  database.close();
}
