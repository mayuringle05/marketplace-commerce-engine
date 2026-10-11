import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
} from "./deterministic.ts";

export interface EnqueueJobInput {
  readonly jobType: string;
  readonly subjectKey: string;
  readonly payload: unknown;
  readonly runAfter: string;
  readonly createdAt: string;
}

export interface LeasedJob {
  readonly id: string;
  readonly jobType: string;
  readonly payloadJson: string;
  readonly fencingToken: bigint;
}

export function enqueueJob(
  database: DatabaseSync,
  input: EnqueueJobInput,
): string {
  assertCanonicalUtcTimestamp(input.runAfter, "runAfter");
  assertCanonicalUtcTimestamp(input.createdAt, "createdAt");
  const payloadJson = canonicalJson(input.payload);
  const id = deterministicId(
    "job",
    input.jobType,
    input.subjectKey,
    payloadJson,
    input.runAfter,
  );

  database
    .prepare(
      `
        INSERT OR IGNORE INTO jobs (
          id,
          job_type,
          payload_json,
          status,
          run_after,
          lease_owner,
          lease_until,
          fencing_token,
          attempts,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'PENDING', ?, NULL, NULL, 0, 0, NULL, ?, ?)
      `,
    )
    .run(
      id,
      input.jobType,
      payloadJson,
      input.runAfter,
      input.createdAt,
      input.createdAt,
    );

  return id;
}

export function leaseNextDueJob(
  database: DatabaseSync,
  owner: string,
  asOf: string,
  leaseUntil: string,
): LeasedJob | null {
  const asOfMs = assertCanonicalUtcTimestamp(asOf, "asOf");
  const leaseUntilMs = assertCanonicalUtcTimestamp(
    leaseUntil,
    "leaseUntil",
  );
  if (leaseUntilMs <= asOfMs) {
    throw new Error("leaseUntil must be after asOf.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE jobs
          SET
            status = 'PENDING',
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = ?
          WHERE status = 'LEASED'
            AND lease_until <= ?
        `,
      )
      .run(asOf, asOf);

    const row = database
      .prepare(
        `
          SELECT id, job_type, payload_json, fencing_token
          FROM jobs
          WHERE status = 'PENDING'
            AND run_after <= ?
          ORDER BY run_after, id
          LIMIT 1
        `,
      )
      .get(asOf) as
      | {
          id: string;
          job_type: string;
          payload_json: string;
          fencing_token: bigint;
        }
      | undefined;

    if (row === undefined) {
      database.exec("COMMIT");
      return null;
    }

    const nextToken = row.fencing_token + 1n;
    const result = database
      .prepare(
        `
          UPDATE jobs
          SET
            status = 'LEASED',
            lease_owner = ?,
            lease_until = ?,
            fencing_token = ?,
            attempts = attempts + 1,
            updated_at = ?
          WHERE id = ?
            AND status = 'PENDING'
            AND fencing_token = ?
        `,
      )
      .run(
        owner,
        leaseUntil,
        nextToken,
        asOf,
        row.id,
        row.fencing_token,
      );

    if (result.changes !== 1n) {
      throw new Error("Job lease compare-and-set failed.");
    }

    database.exec("COMMIT");

    return {
      id: row.id,
      jobType: row.job_type,
      payloadJson: row.payload_json,
      fencingToken: nextToken,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function completeJob(
  database: DatabaseSync,
  jobId: string,
  owner: string,
  fencingToken: bigint,
  completedAt: string,
): void {
  const result = database
    .prepare(
      `
        UPDATE jobs
        SET
          status = 'SUCCEEDED',
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = ?
        WHERE id = ?
          AND status = 'LEASED'
          AND lease_owner = ?
          AND fencing_token = ?
          AND lease_until > ?
      `,
    )
    .run(
      completedAt,
      jobId,
      owner,
      fencingToken,
      completedAt,
    );

  if (result.changes !== 1n) {
    throw new Error("Stale or invalid job fencing token.");
  }
}

export function assertCurrentJobLease(
  database: DatabaseSync,
  jobId: string,
  owner: string,
  fencingToken: bigint,
  asOf: string,
): void {
  const row = database
    .prepare(
      `
        SELECT 1 AS ok
        FROM jobs
        WHERE id = ?
          AND status = 'LEASED'
          AND lease_owner = ?
          AND fencing_token = ?
          AND lease_until > ?
      `,
    )
    .get(jobId, owner, fencingToken, asOf);

  if (row === undefined) {
    throw new Error("Stale or expired job lease.");
  }
}

export function rescheduleLeasedJob(
  database: DatabaseSync,
  jobId: string,
  owner: string,
  fencingToken: bigint,
  runAfter: string,
  errorMessage: string,
  updatedAt: string,
): void {
  assertCanonicalUtcTimestamp(runAfter, "runAfter");
  const result = database
    .prepare(
      `
        UPDATE jobs
        SET
          status = 'PENDING',
          run_after = ?,
          lease_owner = NULL,
          lease_until = NULL,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'LEASED'
          AND lease_owner = ?
          AND fencing_token = ?
      `,
    )
    .run(
      runAfter,
      errorMessage,
      updatedAt,
      jobId,
      owner,
      fencingToken,
    );

  if (result.changes !== 1n) {
    throw new Error("Cannot reschedule stale job lease.");
  }
}

export function quarantineLeasedJob(
  database: DatabaseSync,
  jobId: string,
  owner: string,
  fencingToken: bigint,
  errorMessage: string,
  updatedAt: string,
): void {
  const result = database
    .prepare(
      `
        UPDATE jobs
        SET
          status = 'QUARANTINED',
          lease_owner = NULL,
          lease_until = NULL,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
          AND status = 'LEASED'
          AND lease_owner = ?
          AND fencing_token = ?
      `,
    )
    .run(
      errorMessage,
      updatedAt,
      jobId,
      owner,
      fencingToken,
    );

  if (result.changes !== 1n) {
    throw new Error("Cannot quarantine stale job lease.");
  }
}
