import {
  add,
  asPaise,
  assertBasisPoints,
  assertSafeInteger,
  compare,
  fromPaise,
  grossFromNet,
  multiplyRatio,
  netFromGross,
  ratioAtLeastBps,
  ratioToBps,
  rational,
  scaleIntegerByBps,
  subtract,
  toPaise,
  type Rational,
} from "./money.ts";
import {
  PROBABILITY_PPM_TOTAL,
  type BaseEconomicsResult,
  type CandidateEconomicsResult,
  type EconomicScenario,
  type EconomicsReason,
  type EconomicsStatus,
  type Outcome,
  type OutcomeKind,
  type PriceSearchInput,
  type StressPolicy,
} from "./types.ts";

const ZERO = rational(0n);

export const DEFAULT_STRESS_POLICY: StressPolicy = {
  sourceCostMultiplierBps: 11_000,
  logisticsAndFeesMultiplierBps: 11_500,
  returnAndRtoProbabilityMultiplierBps: 15_000,
};

function sumRationals(values: readonly Rational[]): Rational {
  return values.reduce((total, value) => add(total, value), ZERO);
}

function sumBufferPaise(scenario: EconomicScenario): number {
  return (
    scenario.buffers.feeUncertaintyPaise +
    scenario.buffers.unmodelledPriceRiskPaise +
    scenario.buffers.supplierRiskPaise +
    scenario.buffers.allocatedOverheadPaise
  );
}

function validateNonNegativePaise(value: number, label: string): void {
  assertSafeInteger(value, label);

  if (value < 0) {
    throw new Error(`${label} cannot be negative.`);
  }
}

function validateScenario(scenario: EconomicScenario): void {
  validateNonNegativePaise(
    scenario.customerPriceGrossPaise,
    "customerPriceGrossPaise",
  );
  if (scenario.customerPriceGrossPaise === 0) {
    throw new Error("customerPriceGrossPaise must be greater than zero.");
  }

  assertBasisPoints(scenario.outputTaxRateBps, "outputTaxRateBps");

  validateNonNegativePaise(
    scenario.supplier.grossPaise,
    "supplier.grossPaise",
  );
  assertBasisPoints(
    scenario.supplier.taxRateBps,
    "supplier.taxRateBps",
  );

  const costIds = new Set<string>();
  for (const cost of scenario.keptOrderCosts) {
    if (cost.id.trim().length === 0) {
      throw new Error("Cost component id cannot be empty.");
    }
    if (costIds.has(cost.id)) {
      throw new Error(`Duplicate cost component id: ${cost.id}`);
    }
    costIds.add(cost.id);
    validateNonNegativePaise(cost.netPaise, `${cost.id}.netPaise`);
    assertBasisPoints(
      cost.cashTaxRateBps,
      `${cost.id}.cashTaxRateBps`,
    );
  }

  validateNonNegativePaise(
    scenario.buffers.feeUncertaintyPaise,
    "feeUncertaintyPaise",
  );
  validateNonNegativePaise(
    scenario.buffers.unmodelledPriceRiskPaise,
    "unmodelledPriceRiskPaise",
  );
  validateNonNegativePaise(
    scenario.buffers.supplierRiskPaise,
    "supplierRiskPaise",
  );
  validateNonNegativePaise(
    scenario.buffers.allocatedOverheadPaise,
    "allocatedOverheadPaise",
  );

  validateNonNegativePaise(
    scenario.gates.minimumDecisionProfitPaise,
    "minimumDecisionProfitPaise",
  );
  assertBasisPoints(
    scenario.gates.minimumDecisionMarginBps,
    "minimumDecisionMarginBps",
  );
  assertBasisPoints(
    scenario.gates.minimumCashRoiBps,
    "minimumCashRoiBps",
  );

  if (scenario.outcomes.length === 0) {
    throw new Error("At least one outcome is required.");
  }

  const seenKinds = new Set<OutcomeKind>();
  let totalProbability = 0;
  let keptCount = 0;

  for (const outcome of scenario.outcomes) {
    if (seenKinds.has(outcome.kind)) {
      throw new Error(`Duplicate outcome kind: ${outcome.kind}`);
    }
    seenKinds.add(outcome.kind);

    assertSafeInteger(outcome.probabilityPpm, `${outcome.kind}.probabilityPpm`);
    if (
      outcome.probabilityPpm < 0 ||
      outcome.probabilityPpm > PROBABILITY_PPM_TOTAL
    ) {
      throw new Error(
        `${outcome.kind}.probabilityPpm must be between 0 and ${PROBABILITY_PPM_TOTAL}.`,
      );
    }
    totalProbability += outcome.probabilityPpm;

    if (outcome.kind === "kept") {
      keptCount += 1;
    } else {
      assertSafeInteger(
        outcome.contributionPaise,
        `${outcome.kind}.contributionPaise`,
      );
    }
  }

  if (keptCount !== 1) {
    throw new Error("Exactly one kept outcome is required.");
  }

  if (totalProbability !== PROBABILITY_PPM_TOTAL) {
    throw new Error(
      `Outcome probabilities must sum to ${PROBABILITY_PPM_TOTAL} ppm; received ${totalProbability}.`,
    );
  }
}

function supplierEconomicCost(scenario: EconomicScenario): Rational {
  if (!scenario.supplier.recoverableTax) {
    return fromPaise(scenario.supplier.grossPaise);
  }

  return netFromGross(
    scenario.supplier.grossPaise,
    scenario.supplier.taxRateBps,
  );
}

function outcomeContribution(
  outcome: Outcome,
  keptContribution: Rational,
): Rational {
  if (outcome.kind === "kept") {
    return keptContribution;
  }

  return fromPaise(outcome.contributionPaise);
}

function completeOutcomeRecord(
  scenario: EconomicScenario,
  keptContribution: Rational,
): Readonly<Record<OutcomeKind, ReturnType<typeof asPaise> | null>> {
  const record: Record<OutcomeKind, ReturnType<typeof asPaise> | null> = {
    cancel_before_purchase: null,
    cancel_after_purchase: null,
    kept: null,
    rto: null,
    customer_return: null,
    lost_or_damaged: null,
  };

  for (const outcome of scenario.outcomes) {
    record[outcome.kind] = toPaise(
      outcomeContribution(outcome, keptContribution),
    );
  }

  return record;
}

export function evaluateBaseScenario(
  scenario: EconomicScenario,
): BaseEconomicsResult {
  validateScenario(scenario);

  const netSales = netFromGross(
    scenario.customerPriceGrossPaise,
    scenario.outputTaxRateBps,
  );
  const supplierCost = supplierEconomicCost(scenario);
  const keptCosts = sumRationals(
    scenario.keptOrderCosts.map((cost) => fromPaise(cost.netPaise)),
  );
  const keptContribution = subtract(
    subtract(netSales, supplierCost),
    keptCosts,
  );

  const expectedContribution = sumRationals(
    scenario.outcomes.map((outcome) =>
      multiplyRatio(
        outcomeContribution(outcome, keptContribution),
        outcome.probabilityPpm,
        PROBABILITY_PPM_TOTAL,
      ),
    ),
  );

  const decisionProfit = subtract(
    expectedContribution,
    fromPaise(asPaise(sumBufferPaise(scenario))),
  );

  const peakCashRequirement = add(
    fromPaise(scenario.supplier.grossPaise),
    sumRationals(
      scenario.keptOrderCosts.map((cost) =>
        grossFromNet(cost.netPaise, cost.cashTaxRateBps),
      ),
    ),
  );

  const reasons: EconomicsReason[] = [];

  if (
    compare(
      decisionProfit,
      fromPaise(scenario.gates.minimumDecisionProfitPaise),
    ) < 0
  ) {
    reasons.push("DECISION_PROFIT_BELOW_MINIMUM");
  }

  if (
    !ratioAtLeastBps(
      decisionProfit,
      netSales,
      scenario.gates.minimumDecisionMarginBps,
    )
  ) {
    reasons.push("DECISION_MARGIN_BELOW_MINIMUM");
  }

  if (
    !ratioAtLeastBps(
      decisionProfit,
      peakCashRequirement,
      scenario.gates.minimumCashRoiBps,
    )
  ) {
    reasons.push("CASH_ROI_BELOW_MINIMUM");
  }

  const moneyGatesPassed = reasons.length === 0;

  if (!scenario.evidence.feesKnown) {
    reasons.push("MATERIAL_FEES_UNKNOWN");
  }
  if (!scenario.evidence.taxTreatmentKnown) {
    reasons.push("TAX_TREATMENT_UNKNOWN");
  }
  if (!scenario.evidence.billableWeightAndZoneKnown) {
    reasons.push("BILLABLE_WEIGHT_OR_ZONE_UNKNOWN");
  }

  let status: EconomicsStatus;
  if (!moneyGatesPassed) {
    status = "REJECT";
  } else if (reasons.length > 0) {
    status = "WATCH";
  } else {
    status = "PASS";
  }

  return {
    status,
    reasons,
    moneyGatesPassed,
    netSalesPaise: toPaise(netSales),
    supplierEconomicCostPaise: toPaise(supplierCost),
    keptOrderCostPaise: toPaise(keptCosts),
    keptContributionPaise: toPaise(keptContribution),
    expectedContributionPaise: toPaise(expectedContribution),
    decisionProfitPaise: toPaise(decisionProfit),
    decisionMarginBps: ratioToBps(decisionProfit, netSales),
    peakCashRequirementPaise: toPaise(peakCashRequirement),
    cashRoiBps: ratioToBps(decisionProfit, peakCashRequirement),
    outcomeContributionPaise: completeOutcomeRecord(
      scenario,
      keptContribution,
    ),
  };
}

export function createStressScenario(
  scenario: EconomicScenario,
  policy: StressPolicy = DEFAULT_STRESS_POLICY,
): EconomicScenario {
  validateScenario(scenario);
  assertBasisPoints(
    policy.sourceCostMultiplierBps,
    "sourceCostMultiplierBps",
  );
  assertBasisPoints(
    policy.logisticsAndFeesMultiplierBps,
    "logisticsAndFeesMultiplierBps",
  );
  assertBasisPoints(
    policy.returnAndRtoProbabilityMultiplierBps,
    "returnAndRtoProbabilityMultiplierBps",
  );

  let stressedNonKeptProbability = 0;

  const stressedNonKept = scenario.outcomes
    .filter((outcome) => outcome.kind !== "kept")
    .map((outcome) => {
      const shouldStress =
        outcome.kind === "rto" || outcome.kind === "customer_return";
      const probabilityPpm = shouldStress
        ? scaleIntegerByBps(
            outcome.probabilityPpm,
            policy.returnAndRtoProbabilityMultiplierBps,
          )
        : outcome.probabilityPpm;

      stressedNonKeptProbability += probabilityPpm;

      return {
        ...outcome,
        probabilityPpm,
      };
    });

  if (stressedNonKeptProbability > PROBABILITY_PPM_TOTAL) {
    throw new Error(
      "Stressed non-kept outcome probabilities exceed 100%.",
    );
  }

  const stressedKeptProbability =
    PROBABILITY_PPM_TOTAL - stressedNonKeptProbability;

  const stressedOutcomes: Outcome[] = [
    ...stressedNonKept,
    {
      kind: "kept",
      probabilityPpm: stressedKeptProbability,
    },
  ];

  return {
    ...scenario,
    supplier: {
      ...scenario.supplier,
      grossPaise: asPaise(
        scaleIntegerByBps(
          scenario.supplier.grossPaise,
          policy.sourceCostMultiplierBps,
        ),
      ),
    },
    keptOrderCosts: scenario.keptOrderCosts.map((cost) => ({
      ...cost,
      netPaise: cost.stressEligible
        ? asPaise(
            scaleIntegerByBps(
              cost.netPaise,
              policy.logisticsAndFeesMultiplierBps,
            ),
          )
        : cost.netPaise,
    })),
    outcomes: stressedOutcomes,
  };
}

export function evaluateCandidate(
  scenario: EconomicScenario,
  policy: StressPolicy = DEFAULT_STRESS_POLICY,
): CandidateEconomicsResult {
  const base = evaluateBaseScenario(scenario);
  const stress = evaluateBaseScenario(
    createStressScenario(scenario, policy),
  );

  const reasons = [...base.reasons];
  if (stress.decisionProfitPaise < 0) {
    reasons.push("STRESS_DECISION_PROFIT_NEGATIVE");
  }

  let status = base.status;
  if (stress.decisionProfitPaise < 0) {
    status = "REJECT";
  }

  return {
    status,
    reasons,
    base,
    stress,
  };
}

export function findMinimumGrossPriceForBaseMoneyGates(
  input: PriceSearchInput,
): ReturnType<typeof asPaise> | null {
  validateNonNegativePaise(
    input.minimumGrossPricePaise,
    "minimumGrossPricePaise",
  );
  validateNonNegativePaise(
    input.maximumGrossPricePaise,
    "maximumGrossPricePaise",
  );
  validateNonNegativePaise(input.tickPaise, "tickPaise");

  if (input.tickPaise <= 0) {
    throw new Error("tickPaise must be greater than zero.");
  }
  if (input.minimumGrossPricePaise > input.maximumGrossPricePaise) {
    throw new Error(
      "minimumGrossPricePaise cannot exceed maximumGrossPricePaise.",
    );
  }

  for (
    let price = input.minimumGrossPricePaise;
    price <= input.maximumGrossPricePaise;
    price += input.tickPaise
  ) {
    const result = evaluateBaseScenario({
      ...input.scenario,
      customerPriceGrossPaise: asPaise(price),
    });

    if (result.moneyGatesPassed) {
      return asPaise(price);
    }
  }

  return null;
}
