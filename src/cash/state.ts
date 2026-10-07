import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  deterministicId,
} from "../core/deterministic.ts";

export interface CashAvailability {
  readonly availableCashPaise: bigint;
  readonly activeReservationCashPaise: bigint;
  readonly publicExposureCashPaise: bigint;
  readonly refundReservePaise: bigint;
  readonly settlementDelayReservePaise: bigint;
  readonly uncommittedCashPaise: bigint;
  readonly evidenceRef: string;
}

export function recordVerifiedCashSnapshot(
  database: DatabaseSync,
  availableCashPaise: number,
  evidenceRef: string,
  observedAt: string,
  validUntil: string,
): string {
  if (
    !Number.isSafeInteger(availableCashPaise) ||
    availableCashPaise < 0
  ) {
    throw new Error("Available cash must be a non-negative integer.");
  }
  const observedMs = assertCanonicalUtcTimestamp(
    observedAt,
    "observedAt",
  );
  const validUntilMs = assertCanonicalUtcTimestamp(
    validUntil,
    "validUntil",
  );
  if (validUntilMs <= observedMs) {
    throw new Error("Cash snapshot validity must extend past observation.");
  }
  if (evidenceRef.trim().length === 0) {
    throw new Error("Cash evidence reference is required.");
  }

  const id = deterministicId(
    "cash",
    evidenceRef,
    observedAt,
    String(availableCashPaise),
  );

  database
    .prepare(
      `
        INSERT OR IGNORE INTO cash_snapshots (
          id,
          available_cash_paise,
          evidence_ref,
          observed_at,
          valid_until,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      availableCashPaise,
      evidenceRef,
      observedAt,
      validUntil,
      observedAt,
    );

  return id;
}

export function setCashReservePolicy(
  database: DatabaseSync,
  refundReservePaise: number,
  settlementDelayReservePaise: number,
  updatedAt: string,
): void {
  for (const [label, value] of [
    ["refundReservePaise", refundReservePaise],
    ["settlementDelayReservePaise", settlementDelayReservePaise],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer.`);
    }
  }

  database
    .prepare(
      `
        UPDATE cash_policy
        SET
          refund_reserve_paise = ?,
          settlement_delay_reserve_paise = ?,
          updated_at = ?
        WHERE singleton = 1
      `,
    )
    .run(
      refundReservePaise,
      settlementDelayReservePaise,
      updatedAt,
    );
}

export function readCashAvailability(
  database: DatabaseSync,
  asOf: string,
  excludeListingId: string | null = null,
): CashAvailability {
  assertCanonicalUtcTimestamp(asOf, "asOf");

  const snapshot = database
    .prepare(
      `
        SELECT
          available_cash_paise,
          evidence_ref
        FROM cash_snapshots
        WHERE observed_at <= ?
          AND valid_until > ?
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(asOf, asOf) as
    | {
        available_cash_paise: bigint;
        evidence_ref: string;
      }
    | undefined;

  if (snapshot === undefined) {
    throw new Error("No current verified cash snapshot.");
  }

  const reservations = database
    .prepare(
      `
        SELECT COALESCE(SUM(cash_paise), 0) AS amount
        FROM reservations
        WHERE status = 'ACTIVE'
      `,
    )
    .get() as { amount: bigint };

  const exposure = database
    .prepare(
      `
        SELECT COALESCE(
          SUM(
            COALESCE(l.observed_quantity, 0) *
            COALESCE(o.required_cash_paise_per_unit, 0)
          ),
          0
        ) AS amount
        FROM listings l
        LEFT JOIN opportunities o
          ON o.id = l.opportunity_id
        WHERE l.observed_state = 'ACTIVE'
          AND COALESCE(l.observed_quantity, 0) > 0
          AND (? IS NULL OR l.id != ?)
      `,
    )
    .get(excludeListingId, excludeListingId) as {
    amount: bigint;
  };

  const policy = database
    .prepare(
      `
        SELECT
          refund_reserve_paise,
          settlement_delay_reserve_paise
        FROM cash_policy
        WHERE singleton = 1
      `,
    )
    .get() as {
    refund_reserve_paise: bigint;
    settlement_delay_reserve_paise: bigint;
  };

  const committed =
    reservations.amount +
    exposure.amount +
    policy.refund_reserve_paise +
    policy.settlement_delay_reserve_paise;
  const uncommitted =
    snapshot.available_cash_paise > committed
      ? snapshot.available_cash_paise - committed
      : 0n;

  return {
    availableCashPaise: snapshot.available_cash_paise,
    activeReservationCashPaise: reservations.amount,
    publicExposureCashPaise: exposure.amount,
    refundReservePaise: policy.refund_reserve_paise,
    settlementDelayReservePaise:
      policy.settlement_delay_reserve_paise,
    uncommittedCashPaise: uncommitted,
    evidenceRef: snapshot.evidence_ref,
  };
}
