import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
} from "../core/deterministic.ts";
import type {
  DiscoveryCandidate,
  DiscoveryEvaluation,
} from "./product-discovery.ts";
import type {
  ResearchPricingStrategy,
} from "./pricing-strategy.ts";

export interface PersistResearchEvaluationInput {
  readonly productKey: string;
  readonly generatedAt: string;
  readonly recordedAt: string;
  readonly candidate: DiscoveryCandidate;
  readonly evaluation: DiscoveryEvaluation;
  readonly pricing: ResearchPricingStrategy;
}

export function persistResearchEvaluation(
  database: DatabaseSync,
  input: PersistResearchEvaluationInput,
): string {
  assertCanonicalUtcTimestamp(
    input.generatedAt,
    "generatedAt",
  );
  assertCanonicalUtcTimestamp(
    input.recordedAt,
    "recordedAt",
  );

  const id = deterministicId(
    "research_eval",
    input.productKey,
    input.candidate.candidateId,
    input.generatedAt,
  );

  database
    .prepare(
      `
        INSERT INTO research_evaluations (
          id,
          product_key,
          candidate_id,
          generated_at,
          marketplace,
          market_reference_price_paise,
          supplier_cost_paise,
          competition_score,
          trend_confidence,
          demand_reactive,
          demand_predictive,
          demand_structural,
          demand_score,
          recommendation,
          candidate_score,
          estimated_gross_spread_bps,
          pricing_strategy,
          pricing_confidence_score,
          suggested_floor_price_paise,
          suggested_price_paise,
          suggested_ceiling_price_paise,
          estimated_gross_profit_paise,
          estimated_gross_margin_bps,
          net_profit_verified,
          blocking_reasons_json,
          risk_json,
          sources_json,
          created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, 0, ?, ?, ?, ?
        )
        ON CONFLICT(product_key, candidate_id, generated_at)
        DO UPDATE SET
          marketplace = excluded.marketplace,
          market_reference_price_paise =
            excluded.market_reference_price_paise,
          supplier_cost_paise = excluded.supplier_cost_paise,
          competition_score = excluded.competition_score,
          trend_confidence = excluded.trend_confidence,
          demand_reactive = excluded.demand_reactive,
          demand_predictive = excluded.demand_predictive,
          demand_structural = excluded.demand_structural,
          demand_score = excluded.demand_score,
          recommendation = excluded.recommendation,
          candidate_score = excluded.candidate_score,
          estimated_gross_spread_bps =
            excluded.estimated_gross_spread_bps,
          pricing_strategy = excluded.pricing_strategy,
          pricing_confidence_score =
            excluded.pricing_confidence_score,
          suggested_floor_price_paise =
            excluded.suggested_floor_price_paise,
          suggested_price_paise = excluded.suggested_price_paise,
          suggested_ceiling_price_paise =
            excluded.suggested_ceiling_price_paise,
          estimated_gross_profit_paise =
            excluded.estimated_gross_profit_paise,
          estimated_gross_margin_bps =
            excluded.estimated_gross_margin_bps,
          net_profit_verified = 0,
          blocking_reasons_json =
            excluded.blocking_reasons_json,
          risk_json = excluded.risk_json,
          sources_json = excluded.sources_json,
          created_at = excluded.created_at
      `,
    )
    .run(
      id,
      input.productKey,
      input.candidate.candidateId,
      input.generatedAt,
      input.candidate.marketplace,
      input.pricing.marketReferencePricePaise,
      input.candidate.estimatedSupplierCostPaise,
      input.candidate.competitionScore,
      input.candidate.trendConfidence,
      input.candidate.demand.reactive,
      input.candidate.demand.predictive,
      input.candidate.demand.structural,
      input.evaluation.demandScore,
      input.evaluation.recommendation,
      input.evaluation.candidateScore,
      input.evaluation.estimatedGrossSpreadBps,
      input.pricing.strategy,
      input.pricing.pricingConfidenceScore,
      input.pricing.suggestedFloorPricePaise,
      input.pricing.suggestedPricePaise,
      input.pricing.suggestedCeilingPricePaise,
      input.pricing.estimatedGrossProfitPaise,
      input.pricing.estimatedGrossMarginBps,
      canonicalJson(input.evaluation.blockingReasons),
      canonicalJson(input.candidate.risk),
      canonicalJson(input.candidate.sources),
      input.recordedAt,
    );

  return id;
}
