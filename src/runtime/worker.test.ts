import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { enqueueJob } from "../core/jobs.ts";
import {
  recordPurchaseIntent,
  submitPurchaseOnce,
} from "../procurement/service.ts";
import { runWorkerOnce } from "./worker.ts";
import {
  SimulatedSupplierPurchaseAdapter,
} from "../supplier/simulated-purchase.ts";
import {
  authorizeSingleOrder,
  ingestSingleOrder,
  seedSingleSkuFixture,
} from "../test/commerce-fixture.ts";

const T0 = "2026-10-07T00:00:00.000Z";

test("unresolved purchase reconciliation stays pending until provider history resolves", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter(
    ":memory:",
    "UNKNOWN",
  );

  try {
    const fixture = seedSingleSkuFixture(database);
    const orderId = ingestSingleOrder(database, "WORKER");
    authorizeSingleOrder(
      database,
      orderId,
      fixture.sourceOfferId,
    );
    const poId = recordPurchaseIntent(database, {
      orderId,
      destinationKey: "DEST-WORKER",
      authorizationExpiresAt: "2026-10-07T00:18:00.000Z",
      createdAt: "2026-10-07T00:13:00.000Z",
    });

    submitPurchaseOnce(
      database,
      poId,
      provider,
      "2026-10-07T00:13:30.000Z",
    );

    const jobId = enqueueJob(database, {
      jobType: "RECONCILE_PURCHASE",
      subjectKey: poId,
      payload: { poId },
      runAfter: "2026-10-07T00:14:00.000Z",
      createdAt: "2026-10-07T00:14:00.000Z",
    });

    assert.equal(
      runWorkerOnce(
        database,
        provider,
        "worker-a",
        "2026-10-07T00:14:00.000Z",
        "2026-10-07T00:15:00.000Z",
      ),
      true,
    );

    const pending = database
      .prepare(
        `
          SELECT status, run_after
          FROM jobs
          WHERE id = ?
        `,
      )
      .get(jobId) as {
      status: string;
      run_after: string;
    };
    assert.equal(pending.status, "PENDING");
    assert.equal(
      pending.run_after,
      "2026-10-07T00:15:00.000Z",
    );

    const auth = database
      .prepare(
        `
          SELECT
            a.supplier_id,
            a.supplier_sku,
            a.destination_key,
            a.quantity,
            a.maximum_amount_paise,
            po.idempotency_key,
            po.client_po_ref
          FROM purchase_orders po
          JOIN purchase_authorizations a
            ON a.id = po.authorization_id
          WHERE po.id = ?
        `,
      )
      .get(poId) as {
      supplier_id: string;
      supplier_sku: string;
      destination_key: string;
      quantity: bigint;
      maximum_amount_paise: bigint;
      idempotency_key: string;
      client_po_ref: string;
    };

    provider.recordRecoveredResult(
      {
        idempotencyKey: auth.idempotency_key,
        clientPoRef: auth.client_po_ref,
        supplierId: auth.supplier_id,
        supplierSku: auth.supplier_sku,
        amountPaise: Number(auth.maximum_amount_paise),
        quantity: Number(auth.quantity),
        destinationKey: auth.destination_key,
        submittedAt: "2026-10-07T00:13:30.000Z",
      },
      "CONFIRMED",
    );

    assert.equal(
      runWorkerOnce(
        database,
        provider,
        "worker-b",
        "2026-10-07T00:15:00.000Z",
        "2026-10-07T00:16:00.000Z",
      ),
      true,
    );

    const completed = database
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get(jobId) as { status: string };
    const po = database
      .prepare("SELECT state FROM purchase_orders WHERE id = ?")
      .get(poId) as { state: string };

    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(po.state, "CONFIRMED");
  } finally {
    provider.close();
    database.close();
  }
});

test("poison job is quarantined and does not starve the next due job", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const provider = new SimulatedSupplierPurchaseAdapter();

  try {
    const badId = enqueueJob(database, {
      jobType: "UNSUPPORTED_JOB",
      subjectKey: "bad",
      payload: { bad: true },
      runAfter: T0,
      createdAt: T0,
    });
    const goodId = enqueueJob(database, {
      jobType: "NOOP",
      subjectKey: "good",
      payload: {},
      runAfter: "2026-10-07T00:00:01.000Z",
      createdAt: T0,
    });

    assert.equal(
      runWorkerOnce(
        database,
        provider,
        "worker-a",
        T0,
        "2026-10-07T00:01:00.000Z",
      ),
      true,
    );

    const bad = database
      .prepare(
        "SELECT status, last_error FROM jobs WHERE id = ?",
      )
      .get(badId) as {
      status: string;
      last_error: string;
    };
    assert.equal(bad.status, "QUARANTINED");
    assert.match(bad.last_error, /Unsupported job type/);

    assert.equal(
      runWorkerOnce(
        database,
        provider,
        "worker-b",
        "2026-10-07T00:00:01.000Z",
        "2026-10-07T00:01:01.000Z",
      ),
      true,
    );
    const good = database
      .prepare("SELECT status FROM jobs WHERE id = ?")
      .get(goodId) as { status: string };
    assert.equal(good.status, "SUCCEEDED");
  } finally {
    provider.close();
    database.close();
  }
});
