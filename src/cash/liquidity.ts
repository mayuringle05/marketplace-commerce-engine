import type { DatabaseSync } from "node:sqlite";

import { pauseListingAndConfirm } from "../listings/service.ts";
import { setStopNewExposure } from "../runtime/safety.ts";

export interface LiquidityPolicyInput {
  readonly availableCashPaise: number;
  readonly refundReservePaise: number;
  readonly settlementDelayReservePaise: number;
  readonly evaluatedAt: string;
}

export interface LiquidityDecision {
  readonly passed: boolean;
  readonly committedCashPaise: bigint;
  readonly publicExposureCashPaise: bigint;
  readonly refundReservePaise: bigint;
  readonly settlementDelayReservePaise: bigint;
  readonly requiredCashPaise: bigint;
  readonly availableCashPaise: bigint;
  readonly shortfallPaise: bigint;
}

function assertNonNegativeInteger(
  value: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

export function evaluateLiquidity(
  database: DatabaseSync,
  input: LiquidityPolicyInput,
): LiquidityDecision {
  assertNonNegativeInteger(
    input.availableCashPaise,
    "availableCashPaise",
  );
  assertNonNegativeInteger(
    input.refundReservePaise,
    "refundReservePaise",
  );
  assertNonNegativeInteger(
    input.settlementDelayReservePaise,
    "settlementDelayReservePaise",
  );

  const committed = database
    .prepare(
      `
        SELECT COALESCE(SUM(cash_paise), 0) AS amount
        FROM reservations
        WHERE status = 'ACTIVE'
      `,
    )
    .get() as { amount: bigint };

  const publicExposure = database
    .prepare(
      `
        SELECT COALESCE(
          SUM(
            COALESCE(l.observed_quantity, 0) *
            s.gross_cost_paise
          ),
          0
        ) AS amount
        FROM listings l
        JOIN source_offers s
          ON s.id = l.source_offer_id
        WHERE l.observed_state = 'ACTIVE'
          AND COALESCE(l.observed_quantity, 0) > 0
      `,
    )
    .get() as { amount: bigint };

  const refundReserve = BigInt(input.refundReservePaise);
  const settlementReserve = BigInt(
    input.settlementDelayReservePaise,
  );
  const available = BigInt(input.availableCashPaise);
  const required =
    committed.amount +
    publicExposure.amount +
    refundReserve +
    settlementReserve;
  const shortfall =
    required > available ? required - available : 0n;

  return {
    passed: shortfall === 0n,
    committedCashPaise: committed.amount,
    publicExposureCashPaise: publicExposure.amount,
    refundReservePaise: refundReserve,
    settlementDelayReservePaise: settlementReserve,
    requiredCashPaise: required,
    availableCashPaise: available,
    shortfallPaise: shortfall,
  };
}

export function enforceLiquidityGate(
  database: DatabaseSync,
  input: LiquidityPolicyInput,
): LiquidityDecision {
  const decision = evaluateLiquidity(database, input);

  if (decision.passed) {
    return decision;
  }

  setStopNewExposure(
    database,
    true,
    `LIQUIDITY_SHORTFALL_${decision.shortfallPaise.toString()}_PAISE`,
    input.evaluatedAt,
  );

  const listings = database
    .prepare(
      `
        SELECT marketplace, seller_sku
        FROM listings
        WHERE desired_state != 'PAUSED'
           OR observed_state != 'PAUSED'
           OR COALESCE(observed_quantity, 0) != 0
      `,
    )
    .all() as Array<{
    marketplace: string;
    seller_sku: string;
  }>;

  for (const listing of listings) {
    pauseListingAndConfirm(
      database,
      listing.marketplace,
      listing.seller_sku,
      input.evaluatedAt,
    );
  }

  return decision;
}
