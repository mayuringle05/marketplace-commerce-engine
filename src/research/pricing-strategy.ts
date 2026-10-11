import type {
  DiscoveryCandidate,
  DiscoveryEvaluation,
} from "./product-discovery.ts";

export type ResearchPricingStrategyKind =
  | "BLOCKED"
  | "MARKET_REFERENCE_ONLY"
  | "COMPETITIVE_ENTRY"
  | "BALANCED"
  | "MARGIN_FIRST";

export interface ResearchPricingStrategy {
  readonly strategy: ResearchPricingStrategyKind;
  readonly marketReferencePricePaise: number;
  readonly suggestedFloorPricePaise: number | null;
  readonly suggestedPricePaise: number | null;
  readonly suggestedCeilingPricePaise: number | null;
  readonly estimatedGrossProfitPaise: number | null;
  readonly estimatedGrossMarginBps: number | null;
  readonly pricingConfidenceScore: number;
  readonly netProfitVerified: false;
}

const RESEARCH_MINIMUM_GROSS_MARGIN_BPS = 2_500;

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function ceilDivide(
  numerator: number,
  denominator: number,
): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function scaleBps(
  amountPaise: number,
  basisPoints: number,
): number {
  return Math.round((amountPaise * basisPoints) / 10_000);
}

function roundToWholeRupee(amountPaise: number): number {
  return Math.max(100, Math.round(amountPaise / 100) * 100);
}

export function buildResearchPricingStrategy(
  candidate: DiscoveryCandidate,
  evaluation: DiscoveryEvaluation,
): ResearchPricingStrategy {
  const sourceScore = Math.min(
    100,
    Math.round((candidate.sources.length / 3) * 100),
  );
  const pricingConfidenceScore = clamp(
    Math.round(
      evaluation.candidateScore * 0.4 +
        evaluation.demandScore * 0.25 +
        candidate.trendConfidence * 0.2 +
        sourceScore * 0.15,
    ),
    0,
    100,
  );

  if (evaluation.recommendation === "REJECT") {
    return {
      strategy: "BLOCKED",
      marketReferencePricePaise: candidate.expectedSellPricePaise,
      suggestedFloorPricePaise: null,
      suggestedPricePaise: null,
      suggestedCeilingPricePaise: null,
      estimatedGrossProfitPaise: null,
      estimatedGrossMarginBps: null,
      pricingConfidenceScore,
      netProfitVerified: false,
    };
  }

  if (candidate.estimatedSupplierCostPaise <= 0) {
    return {
      strategy: "MARKET_REFERENCE_ONLY",
      marketReferencePricePaise: candidate.expectedSellPricePaise,
      suggestedFloorPricePaise: null,
      suggestedPricePaise: null,
      suggestedCeilingPricePaise: null,
      estimatedGrossProfitPaise: null,
      estimatedGrossMarginBps: null,
      pricingConfidenceScore,
      netProfitVerified: false,
    };
  }

  const marginFloor = ceilDivide(
    candidate.estimatedSupplierCostPaise * 10_000,
    10_000 - RESEARCH_MINIMUM_GROSS_MARGIN_BPS,
  );
  const marketFloor = scaleBps(
    candidate.expectedSellPricePaise,
    9_500,
  );
  const suggestedFloorPricePaise = roundToWholeRupee(
    Math.max(marginFloor, marketFloor),
  );
  const suggestedCeilingPricePaise = roundToWholeRupee(
    Math.max(
      suggestedFloorPricePaise,
      scaleBps(candidate.expectedSellPricePaise, 11_000),
    ),
  );

  const demandAdjustmentBps =
    evaluation.demandScore >= 80
      ? 500
      : evaluation.demandScore >= 70
        ? 250
        : evaluation.demandScore >= 60
          ? 0
          : -300;
  const competitionAdjustmentBps =
    candidate.competitionScore <= 30
      ? 400
      : candidate.competitionScore <= 45
        ? 200
        : candidate.competitionScore <= 60
          ? 0
          : -300;
  const trendAdjustmentBps =
    candidate.trendConfidence >= 80
      ? 150
      : candidate.trendConfidence >= 65
        ? 50
        : -150;

  const totalAdjustmentBps = clamp(
    demandAdjustmentBps +
      competitionAdjustmentBps +
      trendAdjustmentBps,
    -500,
    1_000,
  );
  const rawSuggestedPrice = scaleBps(
    candidate.expectedSellPricePaise,
    10_000 + totalAdjustmentBps,
  );
  const suggestedPricePaise = clamp(
    roundToWholeRupee(rawSuggestedPrice),
    suggestedFloorPricePaise,
    suggestedCeilingPricePaise,
  );
  const estimatedGrossProfitPaise =
    suggestedPricePaise - candidate.estimatedSupplierCostPaise;
  const estimatedGrossMarginBps = Math.floor(
    (estimatedGrossProfitPaise * 10_000) /
      suggestedPricePaise,
  );

  const strategy: ResearchPricingStrategyKind =
    candidate.competitionScore >= 50
      ? "COMPETITIVE_ENTRY"
      : evaluation.demandScore >= 75 &&
          candidate.competitionScore <= 40
        ? "MARGIN_FIRST"
        : "BALANCED";

  return {
    strategy,
    marketReferencePricePaise: candidate.expectedSellPricePaise,
    suggestedFloorPricePaise,
    suggestedPricePaise,
    suggestedCeilingPricePaise,
    estimatedGrossProfitPaise,
    estimatedGrossMarginBps,
    pricingConfidenceScore,
    netProfitVerified: false,
  };
}
