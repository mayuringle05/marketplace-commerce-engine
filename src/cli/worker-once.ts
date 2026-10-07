import { openDatabase } from "../db/database.ts";
import { runWorkerOnce } from "../runtime/worker.ts";
import { canonicalJson } from "../core/deterministic.ts";
import {
  SimulatedSupplierPurchaseAdapter,
} from "../supplier/simulated-purchase.ts";

const path = process.argv[2] ?? "data/commerce.sqlite";
const providerPath =
  process.argv[3] ?? "data/simulated-supplier.sqlite";
const asOf = process.argv[4] ?? new Date().toISOString();
const leaseUntil =
  process.argv[5] ??
  new Date(new Date(asOf).getTime() + 60_000).toISOString();

const database = openDatabase(path, {
  appliedAt: asOf,
});
const supplier = new SimulatedSupplierPurchaseAdapter(
  providerPath,
);

try {
  const ran = runWorkerOnce(
    database,
    supplier,
    `worker-${process.pid}`,
    asOf,
    leaseUntil,
  );

  process.stdout.write(
    `${canonicalJson({ ran, asOf, leaseUntil })}\n`,
  );
} finally {
  supplier.close();
  database.close();
}
