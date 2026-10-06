import type { DatabaseSync } from "node:sqlite";

import {
  completeJob,
  leaseNextDueJob,
} from "../core/jobs.ts";
import { pauseListingAndConfirm } from "../listings/service.ts";
import { reconcileUnknownPurchase } from "../procurement/service.ts";

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
    reconcileUnknownPurchase(database, typed.poId, asOf);
  } else if (job.jobType !== "NOOP") {
    throw new Error(`Unsupported job type: ${job.jobType}`);
  }

  completeJob(
    database,
    job.id,
    owner,
    job.fencingToken,
    asOf,
  );

  return true;
}
