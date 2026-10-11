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
import type {
  VerifiedCommerceStrategy,
} from "./verified-strategy.ts";

export interface PersistResearchEvaluationInput {
  readonly productKey: string;
  readonly generatedAt: string;
  readonly recordedAt: string;
  readonly candidate: DiscoveryCandidate;
  readonly evaluation: DiscoveryEvaluation;
  readonly pricing: ResearchPricingStrategy;
  readonly verifiedStrategy: VerifiedCommerceStrategy;
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
          demand_class,
          economics_profile_id,
          economics_verification_status,
          economics_status,
          verified_price_paise,
          expected_net_profit_paise,
          decision_margin_bps,
          cash_roi_bps,
          stress_net_profit_paise,
          economics_reasons_json,
          stock_decision,
          recommended_stock_units,
          stock_capital_paise,
          projected_batch_profit_paise,
          reorder_point_units,
          blocking_reasons_json,
          risk_json,
          sources_json,
          created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
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
          net_profit_verified = excluded.net_profit_verified,
          demand_class = excluded.demand_class,
          economics_profile_id = excluded.economics_profile_id,
          economics_verification_status =
            excluded.economics_verification_status,
          economics_status = excluded.economics_status,
          verified_price_paise = excluded.verified_price_paise,
          expected_net_profit_paise = excluded.expected_net_profit_paise,
          decision_margin_bps = excluded.decision_margin_bps,
          cash_roi_bps = excluded.cash_roi_bps,
          stress_net_profit_paise = excluded.stress_net_profit_paise,
          economics_reasons_json = excluded.economics_reasons_json,
          stock_decision = excluded.stock_decision,
          recommended_stock_units = excluded.recommended_stock_units,
          stock_capital_paise = excluded.stock_capital_paise,
          projected_batch_profit_paise = excluded.projected_batch_profit_paise,
          reorder_point_units = excluded.reorder_point_units,
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
      input.verifiedStrategy.netProfitVerified ? 1 : 0,
      input.verifiedStrategy.demandClass,
      input.verifiedStrategy.economicsProfileId,
      input.verifiedStrategy.economicsVerificationStatus,
      input.verifiedStrategy.economicsStatus,
      input.verifiedStrategy.verifiedPricePaise,
      input.verifiedStrategy.expectedNetProfitPaise,
      input.verifiedStrategy.decisionMarginBps,
      input.verifiedStrategy.cashRoiBps,
      input.verifiedStrategy.stressNetProfitPaise,
      canonicalJson(input.verifiedStrategy.economicsReasons),
      input.verifiedStrategy.stockDecision,
      input.verifiedStrategy.recommendedStockUnits,
      input.verifiedStrategy.stockCapitalPaise,
      input.verifiedStrategy.projectedBatchProfitPaise,
      input.verifiedStrategy.reorderPointUnits,
      canonicalJson(input.evaluation.blockingReasons),
      canonicalJson(input.candidate.risk),
      canonicalJson(input.candidate.sources),
      input.recordedAt,
    );

  return id;
}
