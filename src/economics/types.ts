import type { Paise } from "./money.ts";

export const PROBABILITY_PPM_TOTAL = 1_000_000;

export type OutcomeKind =
  | "cancel_before_purchase"
  | "cancel_after_purchase"
  | "kept"
  | "rto"
  | "customer_return"
  | "lost_or_damaged";

export interface KeptOutcome {
  readonly kind: "kept";
  readonly probabilityPpm: number;
}

export interface NonKeptOutcome {
  readonly kind: Exclude<OutcomeKind, "kept">;
  readonly probabilityPpm: number;
  /**
   * All economic cost attributable to this mutually exclusive outcome.
   * Must be non-negative.
   */
  readonly costPaise: Paise;
  /**
   * Conservative recovery attributable to this same outcome.
   * Must be non-negative and must not be booked elsewhere.
   */
  readonly recoveryPaise: Paise;
}

export type Outcome = KeptOutcome | NonKeptOutcome;

export interface SupplierCost {
  readonly grossPaise: Paise;
  readonly taxRateBps: number;
  readonly recoverableTax: boolean;
}

export type EconomicCostKind =
  | "marketplace_fee"
  | "outbound_shipping"
  | "packing_handling"
  | "other";

export interface EconomicCostComponent {
  readonly id: string;
  readonly kind: EconomicCostKind;
  /**
   * Version/date/hash of the rate source or internal cost rule.
   * A marketplace fee must never be an unversioned hard-coded percentage.
   */
  readonly sourceVersion: string;
  readonly netPaise: Paise;
  readonly cashTaxRateBps: number;
  readonly stressEligible: boolean;
}

export interface DecisionBuffers {
  readonly feeUncertaintyPaise: Paise;
  readonly unmodelledPriceRiskPaise: Paise;
  readonly supplierRiskPaise: Paise;
  readonly allocatedOverheadPaise: Paise;
}

export interface MoneyGates {
  readonly minimumDecisionProfitPaise: Paise;
  readonly minimumDecisionMarginBps: number;
  readonly minimumCashRoiBps: number;
}

export interface EvidenceCompleteness {
  readonly feesKnown: boolean;
  readonly taxTreatmentKnown: boolean;
  readonly billableWeightAndZoneKnown: boolean;
}

export interface CashRisk {
  /**
   * Cash deliberately available to absorb one complete order loss.
   * This is checked separately from expected-value profitability.
   */
  readonly availableSingleOrderLossReservePaise: Paise;
}

export interface EconomicScenario {
  readonly customerPriceGrossPaise: Paise;
  readonly outputTaxRateBps: number;
  readonly supplier: SupplierCost;
  readonly keptOrderCosts: readonly EconomicCostComponent[];
  readonly outcomes: readonly Outcome[];
  readonly buffers: DecisionBuffers;
  readonly gates: MoneyGates;
  readonly evidence: EvidenceCompleteness;
  readonly cashRisk: CashRisk;
}

export type EconomicsStatus = "PASS" | "WATCH" | "REJECT";

export type EconomicsReason =
  | "DECISION_PROFIT_BELOW_MINIMUM"
  | "DECISION_MARGIN_BELOW_MINIMUM"
  | "CASH_ROI_BELOW_MINIMUM"
  | "COMPLETE_LOSS_RESERVE_INSUFFICIENT"
  | "MATERIAL_FEES_UNKNOWN"
  | "TAX_TREATMENT_UNKNOWN"
  | "BILLABLE_WEIGHT_OR_ZONE_UNKNOWN"
  | "STRESS_DECISION_PROFIT_NEGATIVE";

export interface BaseEconomicsResult {
  readonly status: EconomicsStatus;
  readonly reasons: readonly EconomicsReason[];
  /**
   * The three price-sensitive gates: minimum profit, margin, and cash ROI.
   */
  readonly pricingGatesPassed: boolean;
  /**
   * Pricing gates plus the separate complete-loss cash-reserve gate.
   */
  readonly moneyGatesPassed: boolean;
  readonly netSalesPaise: Paise;
  readonly supplierEconomicCostPaise: Paise;
  readonly keptOrderCostPaise: Paise;
  readonly keptContributionPaise: Paise;
  readonly expectedContributionPaise: Paise;
  readonly decisionProfitPaise: Paise;
  readonly decisionMarginBps: number;
  readonly peakCashRequirementPaise: Paise;
  readonly completeLossExposurePaise: Paise;
  readonly cashRoiBps: number;
  readonly outcomeContributionPaise: Readonly<Record<OutcomeKind, Paise | null>>;
}

export interface StressPolicy {
  readonly sourceCostMultiplierBps: number;
  readonly logisticsAndFeesMultiplierBps: number;
  readonly returnAndRtoProbabilityMultiplierBps: number;
}

export interface CandidateEconomicsResult {
  readonly status: EconomicsStatus;
  readonly reasons: readonly EconomicsReason[];
  readonly base: BaseEconomicsResult;
  readonly stress: BaseEconomicsResult;
}

export interface PriceSearchInput {
  readonly scenario: EconomicScenario;
  readonly minimumGrossPricePaise: Paise;
  readonly maximumGrossPricePaise: Paise;
  readonly tickPaise: Paise;
}
