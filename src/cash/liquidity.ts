import type { DatabaseSync } from "node:sqlite";

import { readCashAvailability } from "./state.ts";
import {
  pauseAllListingsAndConfirm,
} from "../listings/service.ts";
import { setStopNewExposure } from "../runtime/safety.ts";

export interface LiquidityPolicyInput {
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
  readonly evidenceRef: string;
}

export function evaluateLiquidity(
  database: DatabaseSync,
  input: LiquidityPolicyInput,
): LiquidityDecision {
  const cash = readCashAvailability(
    database,
    input.evaluatedAt,
  );
  const required =
    cash.activeReservationCashPaise +
    cash.publicExposureCashPaise +
    cash.refundReservePaise +
    cash.settlementDelayReservePaise;
  const shortfall =
    required > cash.availableCashPaise
      ? required - cash.availableCashPaise
      : 0n;

  return {
    passed: shortfall === 0n,
    committedCashPaise: cash.activeReservationCashPaise,
    publicExposureCashPaise: cash.publicExposureCashPaise,
    refundReservePaise: cash.refundReservePaise,
    settlementDelayReservePaise:
      cash.settlementDelayReservePaise,
    requiredCashPaise: required,
    availableCashPaise: cash.availableCashPaise,
    shortfallPaise: shortfall,
    evidenceRef: cash.evidenceRef,
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

  pauseAllListingsAndConfirm(
    database,
    input.evaluatedAt,
  );

  return decision;
}
