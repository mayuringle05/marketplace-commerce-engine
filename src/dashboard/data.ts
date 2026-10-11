import type { DatabaseSync } from "node:sqlite";

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new Error("Expected numeric SQLite value.");
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface DashboardRow {
  readonly product_key: string;
  readonly generic_title: string;
  readonly category: string;
  readonly lifecycle_state: string;
  readonly last_intent_id: string | null;
  readonly commercial_intent_score: bigint | null;
  readonly urgency_score: bigint | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly last_deep_researched_at: string | null;
  readonly listed_at: string | null;
  readonly marketplace: string | null;
  readonly market_reference_price_paise: bigint | null;
  readonly supplier_cost_paise: bigint | null;
  readonly competition_score: bigint | null;
  readonly trend_confidence: bigint | null;
  readonly demand_reactive: bigint | null;
  readonly demand_predictive: bigint | null;
  readonly demand_structural: bigint | null;
  readonly demand_score: bigint | null;
  readonly recommendation: string | null;
  readonly candidate_score: bigint | null;
  readonly estimated_gross_spread_bps: bigint | null;
  readonly pricing_strategy: string | null;
  readonly pricing_confidence_score: bigint | null;
  readonly suggested_floor_price_paise: bigint | null;
  readonly suggested_price_paise: bigint | null;
  readonly suggested_ceiling_price_paise: bigint | null;
  readonly estimated_gross_profit_paise: bigint | null;
  readonly estimated_gross_margin_bps: bigint | null;
  readonly net_profit_verified: bigint | null;
  readonly demand_class: string | null;
  readonly economics_profile_id: string | null;
  readonly economics_status: string | null;
  readonly verified_price_paise: bigint | null;
  readonly expected_net_profit_paise: bigint | null;
  readonly decision_margin_bps: bigint | null;
  readonly cash_roi_bps: bigint | null;
  readonly stress_net_profit_paise: bigint | null;
  readonly economics_reasons_json: string | null;
  readonly stock_decision: string | null;
  readonly recommended_stock_units: bigint | null;
  readonly stock_capital_paise: bigint | null;
  readonly projected_batch_profit_paise: bigint | null;
  readonly reorder_point_units: bigint | null;
  readonly blocking_reasons_json: string | null;
  readonly risk_json: string | null;
  readonly sources_json: string | null;
  readonly evaluation_created_at: string | null;
}

export interface CommerceDashboardProduct {
  readonly productKey: string;
  readonly title: string;
  readonly category: string;
  readonly lifecycleState: string;
  readonly intentId: string | null;
  readonly commercialIntentScore: number | null;
  readonly urgencyScore: number | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastDeepResearchedAt: string | null;
  readonly listedAt: string | null;
  readonly evaluation: null | {
    readonly marketplace: string;
    readonly recommendation: string;
    readonly candidateScore: number;
    readonly demandScore: number;
    readonly competitionScore: number;
    readonly trendConfidence: number;
    readonly demandReactive: number;
    readonly demandPredictive: number;
    readonly demandStructural: number;
    readonly marketReferencePricePaise: number;
    readonly supplierCostPaise: number;
    readonly estimatedGrossSpreadBps: number;
    readonly pricingStrategy: string;
    readonly pricingConfidenceScore: number;
    readonly suggestedFloorPricePaise: number | null;
    readonly suggestedPricePaise: number | null;
    readonly suggestedCeilingPricePaise: number | null;
    readonly estimatedGrossProfitPaise: number | null;
    readonly estimatedGrossMarginBps: number | null;
    readonly netProfitVerified: boolean;
    readonly demandClass: string | null;
    readonly economicsProfileId: string | null;
    readonly economicsStatus: string | null;
    readonly verifiedPricePaise: number | null;
    readonly expectedNetProfitPaise: number | null;
    readonly decisionMarginBps: number | null;
    readonly cashRoiBps: number | null;
    readonly stressNetProfitPaise: number | null;
    readonly economicsReasons: readonly string[];
    readonly stockDecision: string | null;
    readonly recommendedStockUnits: number;
    readonly stockCapitalPaise: number;
    readonly projectedBatchProfitPaise: number | null;
    readonly reorderPointUnits: number;
    readonly blockingReasons: readonly string[];
    readonly risk: Readonly<Record<string, boolean>>;
    readonly sources: readonly {
      readonly kind: string;
      readonly url: string;
    }[];
    readonly researchedAt: string;
  };
}

export interface CommerceDashboardSnapshot {
  readonly generatedAt: string;
  readonly summary: {
    readonly totalProducts: number;
    readonly evaluatedProducts: number;
    readonly investigate: number;
    readonly hold: number;
    readonly reject: number;
    readonly listed: number;
    readonly buySmall: number;
    readonly stockWatch: number;
  };
  readonly products: readonly CommerceDashboardProduct[];
}

export function loadCommerceDashboardSnapshot(
  database: DatabaseSync,
): CommerceDashboardSnapshot {
  const rows = database
    .prepare(
      `
        WITH ranked_evaluations AS (
          SELECT
            e.*,
            ROW_NUMBER() OVER (
              PARTITION BY e.product_key
              ORDER BY e.created_at DESC, e.generated_at DESC
            ) AS rank_number
          FROM research_evaluations e
        )
        SELECT
          r.product_key,
          r.generic_title,
          r.category,
          r.lifecycle_state,
          r.last_intent_id,
          r.commercial_intent_score,
          r.urgency_score,
          r.first_seen_at,
          r.last_seen_at,
          r.last_deep_researched_at,
          r.listed_at,
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
          e.net_profit_verified,
          e.demand_class,
          e.economics_profile_id,
          e.economics_status,
          e.verified_price_paise,
          e.expected_net_profit_paise,
          e.decision_margin_bps,
          e.cash_roi_bps,
          e.stress_net_profit_paise,
          e.economics_reasons_json,
          e.stock_decision,
          e.recommended_stock_units,
          e.stock_capital_paise,
          e.projected_batch_profit_paise,
          e.reorder_point_units,
          e.blocking_reasons_json,
          e.risk_json,
          e.sources_json,
          e.created_at AS evaluation_created_at
        FROM research_subjects r
        LEFT JOIN ranked_evaluations e
          ON e.product_key = r.product_key
          AND e.rank_number = 1
        ORDER BY
          COALESCE(e.created_at, r.last_seen_at) DESC,
          r.generic_title ASC
      `,
    )
    .all() as unknown as DashboardRow[];

  const products: CommerceDashboardProduct[] = rows.map((row) => {
    const evaluation =
      row.recommendation === null ||
      row.marketplace === null ||
      row.evaluation_created_at === null
        ? null
        : {
            marketplace: row.marketplace,
            recommendation: row.recommendation,
            candidateScore: asNumber(row.candidate_score) ?? 0,
            demandScore: asNumber(row.demand_score) ?? 0,
            competitionScore:
              asNumber(row.competition_score) ?? 0,
            trendConfidence:
              asNumber(row.trend_confidence) ?? 0,
            demandReactive:
              asNumber(row.demand_reactive) ?? 0,
            demandPredictive:
              asNumber(row.demand_predictive) ?? 0,
            demandStructural:
              asNumber(row.demand_structural) ?? 0,
            marketReferencePricePaise:
              asNumber(row.market_reference_price_paise) ?? 0,
            supplierCostPaise:
              asNumber(row.supplier_cost_paise) ?? 0,
            estimatedGrossSpreadBps:
              asNumber(row.estimated_gross_spread_bps) ?? 0,
            pricingStrategy:
              row.pricing_strategy ?? "BLOCKED",
            pricingConfidenceScore:
              asNumber(row.pricing_confidence_score) ?? 0,
            suggestedFloorPricePaise:
              asNumber(row.suggested_floor_price_paise),
            suggestedPricePaise:
              asNumber(row.suggested_price_paise),
            suggestedCeilingPricePaise:
              asNumber(row.suggested_ceiling_price_paise),
            estimatedGrossProfitPaise:
              asNumber(row.estimated_gross_profit_paise),
            estimatedGrossMarginBps:
              asNumber(row.estimated_gross_margin_bps),
            netProfitVerified:
              asNumber(row.net_profit_verified) === 1,
            demandClass: row.demand_class,
            economicsProfileId: row.economics_profile_id,
            economicsStatus: row.economics_status,
            verifiedPricePaise:
              asNumber(row.verified_price_paise),
            expectedNetProfitPaise:
              asNumber(row.expected_net_profit_paise),
            decisionMarginBps:
              asNumber(row.decision_margin_bps),
            cashRoiBps:
              asNumber(row.cash_roi_bps),
            stressNetProfitPaise:
              asNumber(row.stress_net_profit_paise),
            economicsReasons: parseJson<readonly string[]>(
              row.economics_reasons_json,
              [],
            ),
            stockDecision: row.stock_decision,
            recommendedStockUnits:
              asNumber(row.recommended_stock_units) ?? 0,
            stockCapitalPaise:
              asNumber(row.stock_capital_paise) ?? 0,
            projectedBatchProfitPaise:
              asNumber(row.projected_batch_profit_paise),
            reorderPointUnits:
              asNumber(row.reorder_point_units) ?? 0,
            blockingReasons: parseJson<readonly string[]>(
              row.blocking_reasons_json,
              [],
            ),
            risk: parseJson<Readonly<Record<string, boolean>>>(
              row.risk_json,
              {},
            ),
            sources: parseJson<
              readonly { readonly kind: string; readonly url: string }[]
            >(row.sources_json, []),
            researchedAt: row.evaluation_created_at,
          };

    return {
      productKey: row.product_key,
      title: row.generic_title,
      category: row.category,
      lifecycleState: row.lifecycle_state,
      intentId: row.last_intent_id,
      commercialIntentScore:
        asNumber(row.commercial_intent_score),
      urgencyScore: asNumber(row.urgency_score),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastDeepResearchedAt: row.last_deep_researched_at,
      listedAt: row.listed_at,
      evaluation,
    };
  });

  const summary = {
    totalProducts: products.length,
    evaluatedProducts: products.filter(
      (product) => product.evaluation !== null,
    ).length,
    investigate: products.filter(
      (product) =>
        product.evaluation?.recommendation === "INVESTIGATE",
    ).length,
    hold: products.filter(
      (product) => product.evaluation?.recommendation === "HOLD",
    ).length,
    reject: products.filter(
      (product) => product.evaluation?.recommendation === "REJECT",
    ).length,
    listed: products.filter(
      (product) => product.lifecycleState === "LISTED",
    ).length,
    buySmall: products.filter(
      (product) =>
        product.evaluation?.stockDecision === "BUY_SMALL",
    ).length,
    stockWatch: products.filter(
      (product) =>
        product.evaluation?.stockDecision === "WATCH",
    ).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    products,
  };
}
