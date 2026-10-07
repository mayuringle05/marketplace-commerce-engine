import type { DatabaseSync } from "node:sqlite";

import { assertCanonicalUtcTimestamp } from "../core/deterministic.ts";

export interface AccountLock {
  readonly accountScope: string;
  readonly owner: string;
  readonly fencingToken: bigint;
  readonly leaseUntil: string;
}

export function acquireAccountLock(
  database: DatabaseSync,
  accountScope: string,
  owner: string,
  asOf: string,
  leaseUntil: string,
): AccountLock {
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
    const row = database
      .prepare(
        `
          SELECT owner, fencing_token, lease_until
          FROM account_locks
          WHERE account_scope = ?
        `,
      )
      .get(accountScope) as
      | {
          owner: string;
          fencing_token: bigint;
          lease_until: string;
        }
      | undefined;

    if (row !== undefined && row.lease_until > asOf) {
      throw new Error("Account mutation lock is already active.");
    }

    const token = (row?.fencing_token ?? 0n) + 1n;

    database
      .prepare(
        `
          INSERT INTO account_locks (
            account_scope,
            owner,
            fencing_token,
            lease_until,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(account_scope) DO UPDATE SET
            owner = excluded.owner,
            fencing_token = excluded.fencing_token,
            lease_until = excluded.lease_until,
            updated_at = excluded.updated_at
        `,
      )
      .run(accountScope, owner, token, leaseUntil, asOf);

    database.exec("COMMIT");

    return {
      accountScope,
      owner,
      fencingToken: token,
      leaseUntil,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function assertCurrentAccountLock(
  database: DatabaseSync,
  lock: AccountLock,
  asOf: string,
): void {
  const row = database
    .prepare(
      `
        SELECT owner, fencing_token, lease_until
        FROM account_locks
        WHERE account_scope = ?
      `,
    )
    .get(lock.accountScope) as
    | {
        owner: string;
        fencing_token: bigint;
        lease_until: string;
      }
    | undefined;

  if (
    row === undefined ||
    row.owner !== lock.owner ||
    row.fencing_token !== lock.fencingToken ||
    row.lease_until <= asOf
  ) {
    throw new Error("Stale account fencing token.");
  }
}

export function releaseAccountLock(
  database: DatabaseSync,
  lock: AccountLock,
  releasedAt: string,
): void {
  const result = database
    .prepare(
      `
        DELETE FROM account_locks
        WHERE account_scope = ?
          AND owner = ?
          AND fencing_token = ?
      `,
    )
    .run(
      lock.accountScope,
      lock.owner,
      lock.fencingToken,
    );

  if (result.changes !== 1n) {
    throw new Error(
      `Cannot release stale account lock at ${releasedAt}.`,
    );
  }
}
