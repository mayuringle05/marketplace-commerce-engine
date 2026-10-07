import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, deterministicId } from "../core/deterministic.ts";
import type { CandidateEconomicsResult } from "../economics/types.ts";
import type { IdentityClass } from "../identity/matcher.ts";
import type { OfferFreshnessDecision } from "../supplier/freshness.ts";

export interface DemandEvidence {
  readonly reactive: number;
  readonly predictive: number;
  readonly structural: number;
}

export interface OpportunityInput {
  readonly productId: string;
  readonly tradeUnitId: string;
  readonly sourceOfferId: string;
  readonly marketplace: string;
  readonly approvedPricePaise: number;
  readonly sourceFreshUntil: string;
  readonly identityClass: IdentityClass;
  readonly freshness: OfferFreshnessDecision;
  readonly routeVerified: boolean;
  readonly categoryAllowed: boolean;
  readonly economics: CandidateEconomicsResult;
  readonly demand: DemandEvidence;
  readonly evidenceVersion: string;
  readonly createdAt: string;
}

export interface OpportunityDecision {
  readonly state: "LIST" | "WATCH" | "REJECT";
  readonly hardGatesPassed: boolean;
  readonly opportunityScore: number;
  readonly demandScore: number;
  readonly blockingReasons: readonly string[];
}

function assertScore(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be an integer from 0 to 100.`);
  }
}

export function evaluateOpportunity(
  input: OpportunityInput,
): OpportunityDecision {
  assertScore(input.demand.reactive, "demand.reactive");
  assertScore(input.demand.predictive, "demand.predictive");
  assertScore(input.demand.structural, "demand.structural");

  const blockingReasons: string[] = [];

  if (input.identityClass !== "A" && input.identityClass !== "B") {
    blockingReasons.push("IDENTITY_NOT_AUTOMATION_ELIGIBLE");
  }
  if (!input.freshness.exposable) {
    blockingReasons.push(`SOURCE_${input.freshness.state}`);
  }
  if (!input.routeVerified) {
    blockingReasons.push("ROUTE_NOT_VERIFIED");
  }
  if (!input.categoryAllowed) {
    blockingReasons.push("CATEGORY_BLOCKED");
  }
  if (input.economics.status === "REJECT") {
    blockingReasons.push("ECONOMICS_REJECT");
  }

  const hardGatesPassed = blockingReasons.length === 0;

  const demandScore = Math.round(
    input.demand.reactive * 0.4 +
      input.demand.predictive * 0.25 +
      input.demand.structural * 0.35,
  );

  const economicsScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(input.economics.base.decisionMarginBps / 30),
    ),
  );

  const opportunityScore = Math.round(
    demandScore * 0.45 + economicsScore * 0.55,
  );

  let state: OpportunityDecision["state"];
  if (!hardGatesPassed) {
    state = "REJECT";
  } else if (
    input.economics.status === "WATCH" ||
    opportunityScore < 75
  ) {
    state = "WATCH";
  } else {
    state = "LIST";
  }

  return {
    state,
    hardGatesPassed,
    opportunityScore,
    demandScore,
    blockingReasons,
  };
}

export function persistOpportunity(
  database: DatabaseSync,
  input: OpportunityInput,
): string {
  if (
    !Number.isSafeInteger(input.approvedPricePaise) ||
    input.approvedPricePaise < 0
  ) {
    throw new Error("approvedPricePaise must be a non-negative integer.");
  }
  const freshUntil = new Date(input.sourceFreshUntil);
  if (
    Number.isNaN(freshUntil.getTime()) ||
    freshUntil.toISOString() !== input.sourceFreshUntil
  ) {
    throw new Error("sourceFreshUntil must be a canonical UTC timestamp.");
  }
  if (input.freshness.offer === null) {
    throw new Error("Opportunity requires a concrete source offer.");
  }

  const decision = evaluateOpportunity(input);
  const id = deterministicId(
    "opp",
    input.tradeUnitId,
    input.sourceOfferId,
    input.marketplace,
    input.evidenceVersion,
  );

  database
    .prepare(
      `
        INSERT INTO opportunities (
          id,
          product_id,
          trade_unit_id,
          source_offer_id,
          marketplace,
          decision_state,
          hard_gates_passed,
          opportunity_score,
          demand_score,
          decision_profit_paise,
          blocking_reasons_json,
          evidence_version,
          created_at,
          approved_price_paise,
          required_cash_paise_per_unit,
          source_observed_at,
          source_valid_until,
          source_fresh_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(
          trade_unit_id,
          source_offer_id,
          marketplace,
          evidence_version
        ) DO UPDATE SET
          decision_state = excluded.decision_state,
          hard_gates_passed = excluded.hard_gates_passed,
          opportunity_score = excluded.opportunity_score,
          demand_score = excluded.demand_score,
          decision_profit_paise = excluded.decision_profit_paise,
          blocking_reasons_json = excluded.blocking_reasons_json,
          approved_price_paise = excluded.approved_price_paise,
          required_cash_paise_per_unit = excluded.required_cash_paise_per_unit,
          source_observed_at = excluded.source_observed_at,
          source_valid_until = excluded.source_valid_until,
          source_fresh_until = excluded.source_fresh_until
      `,
    )
    .run(
      id,
      input.productId,
      input.tradeUnitId,
      input.sourceOfferId,
      input.marketplace,
      decision.state,
      decision.hardGatesPassed ? 1 : 0,
      decision.opportunityScore,
      decision.demandScore,
      input.economics.base.decisionProfitPaise,
      canonicalJson(decision.blockingReasons),
      input.evidenceVersion,
      input.createdAt,
      input.approvedPricePaise,
      input.economics.base.peakCashRequirementPaise,
      input.freshness.offer.observedAt,
      input.freshness.offer.validUntil,
      input.sourceFreshUntil,
    );

  return id;
}
