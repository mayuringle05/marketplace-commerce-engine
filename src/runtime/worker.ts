import type { DatabaseSync } from "node:sqlite";

import {
  assertCurrentJobLease,
  completeJob,
  leaseNextDueJob,
  quarantineLeasedJob,
  rescheduleLeasedJob,
} from "../core/jobs.ts";
import { pauseListingAndConfirm } from "../listings/service.ts";
import { reconcilePurchase } from "../procurement/service.ts";
import type { SupplierPurchaseAdapter } from "../supplier/simulated-purchase.ts";

interface PauseListingPayload {
  readonly marketplace: string;
  readonly sellerSku: string;
}

interface ReconcilePurchasePayload {
  readonly poId: string;
}

function parseObject(json: string): Record<string, unknown> {
  const value = JSON.parse(json) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Job payload must be an object.");
  }
  return value as Record<string, unknown>;
}

export function runWorkerOnce(
  database: DatabaseSync,
  supplierAdapter: SupplierPurchaseAdapter,
  owner: string,
  asOf: string,
  leaseUntil: string,
): boolean {
  const job = leaseNextDueJob(
    database,
    owner,
    asOf,
    leaseUntil,
  );

  if (job === null) {
    return false;
  }

  try {
    assertCurrentJobLease(
      database,
      job.id,
      owner,
      job.fencingToken,
      asOf,
    );
    const payload = parseObject(job.payloadJson);

    if (job.jobType === "PAUSE_LISTING") {
      if (
        typeof payload.marketplace !== "string" ||
        typeof payload.sellerSku !== "string"
      ) {
        throw new Error("Invalid PAUSE_LISTING job payload.");
      }

      const typed = payload as unknown as PauseListingPayload;
      pauseListingAndConfirm(
        database,
        typed.marketplace,
        typed.sellerSku,
        asOf,
      );
    } else if (job.jobType === "RECONCILE_PURCHASE") {
      if (typeof payload.poId !== "string") {
        throw new Error("Invalid RECONCILE_PURCHASE job payload.");
      }

      const typed = payload as unknown as ReconcilePurchasePayload;
      const resolved = reconcilePurchase(
        database,
        typed.poId,
        supplierAdapter,
        asOf,
      );

      if (!resolved) {
        const retryAt = new Date(
          new Date(asOf).getTime() + 60_000,
        ).toISOString();
        rescheduleLeasedJob(
          database,
          job.id,
          owner,
          job.fencingToken,
          retryAt,
          "Provider state remains unresolved; reconciliation retained.",
          asOf,
        );
        return true;
      }
    } else if (job.jobType !== "NOOP") {
      throw new Error(`Unsupported job type: ${job.jobType}`);
    }

    assertCurrentJobLease(
      database,
      job.id,
      owner,
      job.fencingToken,
      asOf,
    );
    completeJob(
      database,
      job.id,
      owner,
      job.fencingToken,
      asOf,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    try {
      quarantineLeasedJob(
        database,
        job.id,
        owner,
        job.fencingToken,
        message,
        asOf,
      );
    } catch {
      // If the lease was taken over, this worker no longer owns
      // the right to alter job state.
    }
  }

  return true;
}
