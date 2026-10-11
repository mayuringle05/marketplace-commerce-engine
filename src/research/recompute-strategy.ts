import type { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "../core/deterministic.ts";
import {
  findActiveEconomicsProfile,
} from "./economics-profile.ts";
import type {
  DiscoveryCandidate,
  DiscoveryEvaluation,
} from "./product-discovery.ts";
import type {
  ResearchPricingStrategy,
} from "./pricing-strategy.ts";
import {
  buildVerifiedCommerceStrategy,
} from "./verified-strategy.ts";

interface StoredRow {
  readonly id: string;
  readonly candidate_id: string;
  readonly generic_title: string;
  readonly category: string;
  readonly marketplace: "AMAZON_IN" | "FLIPKART_IN";
  readonly market_reference_price_paise: bigint;
  readonly supplier_cost_paise: bigint;
  readonly competition_score: bigint;
  readonly trend_confidence: bigint;
  readonly demand_reactive: bigint;
  readonly demand_predictive: bigint;
  readonly demand_structural: bigint;
  readonly demand_score: bigint;
  readonly recommendation: "INVESTIGATE" | "HOLD" | "REJECT";
  readonly candidate_score: bigint;
  readonly estimated_gross_spread_bps: bigint;
  readonly pricing_strategy: ResearchPricingStrategy["strategy"];
  readonly pricing_confidence_score: bigint;
  readonly suggested_floor_price_paise: bigint | null;
  readonly suggested_price_paise: bigint | null;
  readonly suggested_ceiling_price_paise: bigint | null;
  readonly estimated_gross_profit_paise: bigint | null;
  readonly estimated_gross_margin_bps: bigint | null;
  readonly blocking_reasons_json: string;
  readonly risk_json: string;
  readonly sources_json: string;
}

function number(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

export function recomputeStoredResearchStrategies(
  database: DatabaseSync,
  evaluatedAt: string,
): number {
  const rows = database
    .prepare(
      `
        SELECT
          e.id,
          e.candidate_id,
          r.generic_title,
          r.category,
          e.marketplace,
          e.market_reference_price_paise,
          e.supplier_cost_paise,
          e.competition_score,
          e.trend_confidence,
          e.demand_reactive,
          e.demand_predictive,
          e.demand_structural,
          e.demand_score,
          e.recommendation,
          e.candidate_score,
          e.estimated_gross_spread_bps,
          e.pricing_strategy,
          e.pricing_confidence_score,
          e.suggested_floor_price_paise,
          e.suggested_price_paise,
          e.suggested_ceiling_price_paise,
          e.estimated_gross_profit_paise,
          e.estimated_gross_margin_bps,
          e.blocking_reasons_json,
          e.risk_json,
          e.sources_json
        FROM research_evaluations e
        JOIN research_subjects r
          ON r.product_key = e.product_key
      `,
    )
    .all() as unknown as StoredRow[];

  const update = database.prepare(
    `
      UPDATE research_evaluations
      SET
        net_profit_verified = ?,
        demand_class = ?,
        economics_profile_id = ?,
        economics_verification_status = ?,
        economics_status = ?,
        verified_price_paise = ?,
        expected_net_profit_paise = ?,
        decision_margin_bps = ?,
        cash_roi_bps = ?,
        stress_net_profit_paise = ?,
        economics_reasons_json = ?,
        stock_decision = ?,
        recommended_stock_units = ?,
        stock_capital_paise = ?,
        projected_batch_profit_paise = ?,
        reorder_point_units = ?
      WHERE id = ?
    `,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const candidate: DiscoveryCandidate = {
        candidateId: row.candidate_id,
        title: row.generic_title,
        marketplace: row.marketplace,
        category: row.category,
        expectedSellPricePaise: Number(
          row.market_reference_price_paise,
        ),
        estimatedSupplierCostPaise: Number(
          row.supplier_cost_paise,
        ),
        competitionScore: Number(row.competition_score),
        trendConfidence: Number(row.trend_confidence),
        demand: {
          reactive: Number(row.demand_reactive),
          predictive: Number(row.demand_predictive),
          structural: Number(row.demand_structural),
        },
        risk: JSON.parse(row.risk_json) as DiscoveryCandidate["risk"],
        sources: JSON.parse(
          row.sources_json,
        ) as DiscoveryCandidate["sources"],
      };
      const evaluation: DiscoveryEvaluation = {
        candidateId: row.candidate_id,
        recommendation: row.recommendation,
        candidateScore: Number(row.candidate_score),
        demandScore: Number(row.demand_score),
        estimatedGrossSpreadBps: Number(
          row.estimated_gross_spread_bps,
        ),
        blockingReasons: JSON.parse(
          row.blocking_reasons_json,
        ) as string[],
        listingEligible: false,
        transactionAuthority: false,
      };
      const pricing: ResearchPricingStrategy = {
        strategy: row.pricing_strategy,
        marketReferencePricePaise: Number(
          row.market_reference_price_paise,
        ),
        suggestedFloorPricePaise: number(
          row.suggested_floor_price_paise,
        ),
        suggestedPricePaise: number(
          row.suggested_price_paise,
        ),
        suggestedCeilingPricePaise: number(
          row.suggested_ceiling_price_paise,
        ),
        estimatedGrossProfitPaise: number(
          row.estimated_gross_profit_paise,
        ),
        estimatedGrossMarginBps: number(
          row.estimated_gross_margin_bps,
        ),
        pricingConfidenceScore: Number(
          row.pricing_confidence_score,
        ),
        netProfitVerified: false,
      };
      const profile = findActiveEconomicsProfile(
        database,
        candidate.marketplace,
        candidate.category,
        evaluatedAt,
      );
      const strategy = buildVerifiedCommerceStrategy(
        candidate,
        evaluation,
        pricing,
        profile,
      );

      update.run(
        strategy.netProfitVerified ? 1 : 0,
        strategy.demandClass,
        strategy.economicsProfileId,
        strategy.economicsVerificationStatus,
        strategy.economicsStatus,
        strategy.verifiedPricePaise,
        strategy.expectedNetProfitPaise,
        strategy.decisionMarginBps,
        strategy.cashRoiBps,
        strategy.stressNetProfitPaise,
        canonicalJson(strategy.economicsReasons),
        strategy.stockDecision,
        strategy.recommendedStockUnits,
        strategy.stockCapitalPaise,
        strategy.projectedBatchProfitPaise,
        strategy.reorderPointUnits,
        row.id,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return rows.length;
}
