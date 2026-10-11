import {
  evaluateCandidate,
} from "../economics/engine.ts";
import {
  asPaise,
} from "../economics/money.ts";
import type {
  CandidateEconomicsResult,
  EconomicScenario,
} from "../economics/types.ts";
import type {
  MarketplaceEconomicsProfile,
} from "./economics-profile.ts";
import type {
  DiscoveryCandidate,
  DiscoveryEvaluation,
} from "./product-discovery.ts";
import type {
  ResearchPricingStrategy,
} from "./pricing-strategy.ts";

export type DemandClass =
  | "EVERGREEN"
  | "SEASONAL"
  | "MIXED"
  | "UNPROVEN";

export type StockDecision =
  | "BUY_SMALL"
  | "WATCH"
  | "DO_NOT_STOCK";

export interface VerifiedCommerceStrategy {
  readonly demandClass: DemandClass;
  readonly economicsProfileId: string | null;
  readonly economicsVerificationStatus:
    | "PUBLIC_STANDARD"
    | "VERIFIED"
    | null;
  readonly economicsStatus: "PASS" | "WATCH" | "REJECT" | null;
  readonly verifiedPricePaise: number | null;
  readonly expectedNetProfitPaise: number | null;
  readonly decisionMarginBps: number | null;
  readonly cashRoiBps: number | null;
  readonly stressNetProfitPaise: number | null;
  readonly economicsReasons: readonly string[];
  readonly stockDecision: StockDecision;
  readonly recommendedStockUnits: number;
  readonly stockCapitalPaise: number;
  readonly projectedBatchProfitPaise: number | null;
  readonly reorderPointUnits: number;
  readonly netProfitVerified: boolean;
}

function scaleBps(
  amountPaise: number,
  bps: number,
): number {
  return Math.round((amountPaise * bps) / 10_000);
}

export function classifyDemand(
  candidate: DiscoveryCandidate,
): DemandClass {
  const { reactive, predictive, structural } = candidate.demand;

  if (
    structural >= 75 &&
    reactive >= 60 &&
    structural >= predictive - 15
  ) {
    return "EVERGREEN";
  }

  if (
    predictive >= 70 &&
    candidate.trendConfidence >= 70 &&
    predictive >= structural + 15
  ) {
    return "SEASONAL";
  }

  if (
    structural >= 60 &&
    predictive >= 60 &&
    reactive >= 55
  ) {
    return "MIXED";
  }

  return "UNPROVEN";
}

function scenarioAtPrice(
  candidate: DiscoveryCandidate,
  profile: MarketplaceEconomicsProfile,
  pricePaise: number,
): EconomicScenario {
  const marketplaceFeePaise =
    scaleBps(pricePaise, profile.marketplaceFeeBps) +
    profile.fixedMarketplaceFeePaise;
  const nonKept =
    profile.rtoProbabilityPpm +
    profile.customerReturnProbabilityPpm;

  return {
    customerPriceGrossPaise: asPaise(pricePaise),
    outputTaxRateBps: profile.outputTaxRateBps,
    supplier: {
      grossPaise: asPaise(
        candidate.estimatedSupplierCostPaise,
      ),
      taxRateBps: profile.supplierTaxRateBps,
      recoverableTax: profile.supplierTaxRecoverable,
    },
    keptOrderCosts: [
      {
        id: "marketplace-fee",
        kind: "marketplace_fee",
        sourceVersion: profile.sourceVersion,
        netPaise: asPaise(marketplaceFeePaise),
        cashTaxRateBps: profile.costTaxRateBps,
        stressEligible: true,
      },
      {
        id: "outbound-shipping",
        kind: "outbound_shipping",
        sourceVersion: profile.sourceVersion,
        netPaise: asPaise(profile.shippingPaise),
        cashTaxRateBps: profile.costTaxRateBps,
        stressEligible: true,
      },
      {
        id: "packing-handling",
        kind: "packing_handling",
        sourceVersion: profile.sourceVersion,
        netPaise: asPaise(profile.packingHandlingPaise),
        cashTaxRateBps: profile.costTaxRateBps,
        stressEligible: false,
      },
    ],
    outcomes: [
      {
        kind: "kept",
        probabilityPpm: 1_000_000 - nonKept,
      },
      ...(profile.rtoProbabilityPpm > 0
        ? [
            {
              kind: "rto" as const,
              probabilityPpm: profile.rtoProbabilityPpm,
              costPaise: asPaise(profile.rtoCostPaise),
              recoveryPaise: asPaise(0),
            },
          ]
        : []),
      ...(profile.customerReturnProbabilityPpm > 0
        ? [
            {
              kind: "customer_return" as const,
              probabilityPpm:
                profile.customerReturnProbabilityPpm,
              costPaise: asPaise(
                profile.customerReturnCostPaise,
              ),
              recoveryPaise: asPaise(0),
            },
          ]
        : []),
    ],
    buffers: {
      feeUncertaintyPaise: asPaise(
        profile.feeUncertaintyPaise,
      ),
      unmodelledPriceRiskPaise: asPaise(
        profile.unmodelledPriceRiskPaise,
      ),
      supplierRiskPaise: asPaise(
        profile.supplierRiskPaise,
      ),
      allocatedOverheadPaise: asPaise(
        profile.allocatedOverheadPaise,
      ),
    },
    gates: {
      minimumDecisionProfitPaise: asPaise(
        profile.minimumDecisionProfitPaise,
      ),
      minimumDecisionMarginBps:
        profile.minimumDecisionMarginBps,
      minimumCashRoiBps: profile.minimumCashRoiBps,
    },
    evidence: {
      feesKnown: true,
      taxTreatmentKnown: true,
      billableWeightAndZoneKnown: true,
    },
    cashRisk: {
      availableSingleOrderLossReservePaise: asPaise(
        profile.availableSingleOrderLossReservePaise,
      ),
    },
  };
}

interface PriceResult {
  readonly pricePaise: number;
  readonly economics: CandidateEconomicsResult;
}

function optimizePrice(
  candidate: DiscoveryCandidate,
  pricing: ResearchPricingStrategy,
  profile: MarketplaceEconomicsProfile,
): PriceResult | null {
  if (
    pricing.suggestedFloorPricePaise === null ||
    pricing.suggestedCeilingPricePaise === null
  ) {
    return null;
  }

  let bestPass: PriceResult | null = null;
  let bestAny: PriceResult | null = null;

  for (
    let price = pricing.suggestedFloorPricePaise;
    price <= pricing.suggestedCeilingPricePaise;
    price += 100
  ) {
    const economics = evaluateCandidate(
      scenarioAtPrice(candidate, profile, price),
    );
    const current = { pricePaise: price, economics };

    if (
      bestAny === null ||
      economics.base.decisionProfitPaise >
        bestAny.economics.base.decisionProfitPaise
    ) {
      bestAny = current;
    }

    if (
      economics.status === "PASS" &&
      (bestPass === null ||
        economics.base.decisionProfitPaise >
          bestPass.economics.base.decisionProfitPaise)
    ) {
      bestPass = current;
    }
  }

  return bestPass ?? bestAny;
}

function desiredPilotUnits(
  demandClass: DemandClass,
  evaluation: DiscoveryEvaluation,
  candidate: DiscoveryCandidate,
): number {
  if (demandClass === "EVERGREEN") {
    if (evaluation.demandScore >= 85) return 8;
    if (evaluation.demandScore >= 75) return 5;
    return 3;
  }

  if (demandClass === "SEASONAL") {
    if (
      candidate.demand.predictive >= 85 &&
      candidate.trendConfidence >= 80
    ) {
      return 5;
    }
    return 3;
  }

  if (demandClass === "MIXED") {
    return evaluation.demandScore >= 75 ? 3 : 2;
  }

  return 0;
}

export function buildVerifiedCommerceStrategy(
  candidate: DiscoveryCandidate,
  evaluation: DiscoveryEvaluation,
  pricing: ResearchPricingStrategy,
  profile: MarketplaceEconomicsProfile | null,
): VerifiedCommerceStrategy {
  const demandClass = classifyDemand(candidate);

  if (evaluation.recommendation === "REJECT") {
    return {
      demandClass,
      economicsProfileId: profile?.profileId ?? null,
      economicsVerificationStatus:
        profile?.verificationStatus ?? null,
      economicsStatus: null,
      verifiedPricePaise: null,
      expectedNetProfitPaise: null,
      decisionMarginBps: null,
      cashRoiBps: null,
      stressNetProfitPaise: null,
      economicsReasons: evaluation.blockingReasons,
      stockDecision: "DO_NOT_STOCK",
      recommendedStockUnits: 0,
      stockCapitalPaise: 0,
      projectedBatchProfitPaise: null,
      reorderPointUnits: 0,
      netProfitVerified: false,
    };
  }

  if (
    profile === null ||
    candidate.estimatedSupplierCostPaise <= 0
  ) {
    return {
      demandClass,
      economicsProfileId: profile?.profileId ?? null,
      economicsVerificationStatus:
        profile?.verificationStatus ?? null,
      economicsStatus: null,
      verifiedPricePaise: null,
      expectedNetProfitPaise: null,
      decisionMarginBps: null,
      cashRoiBps: null,
      stressNetProfitPaise: null,
      economicsReasons: [
        profile === null
          ? "VERIFIED_ECONOMICS_PROFILE_MISSING"
          : "SUPPLIER_COST_UNVERIFIED",
      ],
      stockDecision: "WATCH",
      recommendedStockUnits: 0,
      stockCapitalPaise: 0,
      projectedBatchProfitPaise: null,
      reorderPointUnits: 0,
      netProfitVerified: false,
    };
  }

  const optimized = optimizePrice(
    candidate,
    pricing,
    profile,
  );

  if (optimized === null) {
    return {
      demandClass,
      economicsProfileId: profile.profileId,
      economicsVerificationStatus:
        profile.verificationStatus,
      economicsStatus: null,
      verifiedPricePaise: null,
      expectedNetProfitPaise: null,
      decisionMarginBps: null,
      cashRoiBps: null,
      stressNetProfitPaise: null,
      economicsReasons: ["ACTIONABLE_PRICE_BAND_MISSING"],
      stockDecision: "WATCH",
      recommendedStockUnits: 0,
      stockCapitalPaise: 0,
      projectedBatchProfitPaise: null,
      reorderPointUnits: 0,
      netProfitVerified: false,
    };
  }

  const { economics, pricePaise } = optimized;

  if (profile.verificationStatus === "PUBLIC_STANDARD") {
    return {
      demandClass,
      economicsProfileId: profile.profileId,
      economicsVerificationStatus: "PUBLIC_STANDARD",
      economicsStatus: economics.status,
      verifiedPricePaise: null,
      expectedNetProfitPaise:
        economics.base.decisionProfitPaise,
      decisionMarginBps: economics.base.decisionMarginBps,
      cashRoiBps: economics.base.cashRoiBps,
      stressNetProfitPaise:
        economics.stress.decisionProfitPaise,
      economicsReasons: [
        "PUBLIC_STANDARD_ECONOMICS_NOT_SELLER_VERIFIED",
        ...economics.reasons,
      ],
      stockDecision:
        economics.status === "REJECT" ||
        economics.stress.decisionProfitPaise < 0
          ? "DO_NOT_STOCK"
          : "WATCH",
      recommendedStockUnits: 0,
      stockCapitalPaise: 0,
      projectedBatchProfitPaise: null,
      reorderPointUnits: 0,
      netProfitVerified: false,
    };
  }

  const canPilot =
    evaluation.recommendation === "INVESTIGATE" &&
    economics.status === "PASS" &&
    economics.stress.decisionProfitPaise >= 0 &&
    demandClass !== "UNPROVEN";

  const desiredUnits = canPilot
    ? desiredPilotUnits(demandClass, evaluation, candidate)
    : 0;
  const capitalUnits = Math.floor(
    profile.maxInitialStockCapitalPaise /
      candidate.estimatedSupplierCostPaise,
  );
  const recommendedStockUnits = Math.max(
    0,
    Math.min(
      desiredUnits,
      profile.maxInitialStockUnits,
      capitalUnits,
    ),
  );
  const stockDecision: StockDecision =
    recommendedStockUnits > 0
      ? "BUY_SMALL"
      : economics.status === "REJECT" ||
          economics.stress.decisionProfitPaise < 0
        ? "DO_NOT_STOCK"
        : "WATCH";
  const stockCapitalPaise =
    recommendedStockUnits *
    candidate.estimatedSupplierCostPaise;
  const projectedBatchProfitPaise =
    recommendedStockUnits > 0
      ? recommendedStockUnits *
        economics.base.decisionProfitPaise
      : null;
  const reorderPointUnits =
    recommendedStockUnits > 0
      ? Math.max(
          1,
          Math.ceil(recommendedStockUnits * 0.3),
        )
      : 0;

  return {
    demandClass,
    economicsProfileId: profile.profileId,
    economicsVerificationStatus: "VERIFIED",
    economicsStatus: economics.status,
    verifiedPricePaise: pricePaise,
    expectedNetProfitPaise:
      economics.base.decisionProfitPaise,
    decisionMarginBps: economics.base.decisionMarginBps,
    cashRoiBps: economics.base.cashRoiBps,
    stressNetProfitPaise:
      economics.stress.decisionProfitPaise,
    economicsReasons: economics.reasons,
    stockDecision,
    recommendedStockUnits,
    stockCapitalPaise,
    projectedBatchProfitPaise,
    reorderPointUnits,
    netProfitVerified: true,
  };
}
