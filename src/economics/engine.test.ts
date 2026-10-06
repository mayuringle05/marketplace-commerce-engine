import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateBaseScenario,
  evaluateCandidate,
  findMinimumGrossPriceForBaseMoneyGates,
} from "./engine.ts";
import { asPaise } from "./money.ts";
import type { EconomicScenario } from "./types.ts";

function strategyExample(
  supplierGrossPaise = 35_000,
): EconomicScenario {
  return {
    customerPriceGrossPaise: asPaise(79_900),
    outputTaxRateBps: 1_800,
    supplier: {
      grossPaise: asPaise(supplierGrossPaise),
      taxRateBps: 1_800,
      recoverableTax: true,
    },
    keptOrderCosts: [
      {
        id: "marketplace-and-outbound",
        netPaise: asPaise(11_500),
        cashTaxRateBps: 1_800,
        stressEligible: true,
      },
      {
        id: "packing-and-pick",
        netPaise: asPaise(2_000),
        cashTaxRateBps: 1_800,
        stressEligible: false,
      },
    ],
    outcomes: [
      {
        kind: "kept",
        probabilityPpm: 870_000,
      },
      {
        kind: "rto",
        probabilityPpm: 80_000,
        contributionPaise: asPaise(-15_000),
      },
      {
        kind: "customer_return",
        probabilityPpm: 50_000,
        contributionPaise: asPaise(-19_000),
      },
    ],
    buffers: {
      feeUncertaintyPaise: asPaise(1_000),
      unmodelledPriceRiskPaise: asPaise(1_500),
      supplierRiskPaise: asPaise(1_000),
      allocatedOverheadPaise: asPaise(1_200),
    },
    gates: {
      minimumDecisionProfitPaise: asPaise(10_000),
      minimumDecisionMarginBps: 1_500,
      minimumCashRoiBps: 2_000,
    },
    evidence: {
      feesKnown: true,
      taxTreatmentKnown: true,
      billableWeightAndZoneKnown: true,
    },
  };
}

test("reproduces the Section 28 underwriting example", () => {
  const result = evaluateCandidate(strategyExample());

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.reasons, []);

  assert.equal(result.base.netSalesPaise, 67_712);
  assert.equal(result.base.supplierEconomicCostPaise, 29_661);
  assert.equal(result.base.keptOrderCostPaise, 13_500);
  assert.equal(result.base.keptContributionPaise, 24_551);
  assert.equal(result.base.expectedContributionPaise, 19_209);
  assert.equal(result.base.decisionProfitPaise, 14_509);
  assert.equal(result.base.decisionMarginBps, 2_143);
  assert.equal(result.base.peakCashRequirementPaise, 50_930);
  assert.equal(result.base.cashRoiBps, 2_849);

  assert.ok(result.stress.decisionProfitPaise >= 0);
  assert.ok(
    result.stress.decisionProfitPaise <
      result.base.decisionProfitPaise,
  );
});

test("reproduces the supplier-price breach branch", () => {
  const result = evaluateBaseScenario(strategyExample(51_000));

  assert.equal(result.decisionProfitPaise, 2_713);
  assert.equal(result.status, "REJECT");
  assert.ok(
    result.reasons.includes("DECISION_PROFIT_BELOW_MINIMUM"),
  );
});

test("finds the strategy example minimum price of about ₹943.77", () => {
  const minimum = findMinimumGrossPriceForBaseMoneyGates({
    scenario: strategyExample(51_000),
    minimumGrossPricePaise: asPaise(79_900),
    maximumGrossPricePaise: asPaise(100_000),
    tickPaise: asPaise(1),
  });

  assert.equal(minimum, 94_377);
});

test("reproduces the matured kept-order contribution", () => {
  const scenario: EconomicScenario = {
    ...strategyExample(36_000),
    keptOrderCosts: [
      {
        id: "actual-marketplace-and-outbound",
        netPaise: asPaise(12_500),
        cashTaxRateBps: 1_800,
        stressEligible: true,
      },
      {
        id: "packing",
        netPaise: asPaise(2_000),
        cashTaxRateBps: 1_800,
        stressEligible: false,
      },
    ],
    outcomes: [
      {
        kind: "kept",
        probabilityPpm: 1_000_000,
      },
    ],
    buffers: {
      feeUncertaintyPaise: asPaise(0),
      unmodelledPriceRiskPaise: asPaise(0),
      supplierRiskPaise: asPaise(0),
      allocatedOverheadPaise: asPaise(0),
    },
    gates: {
      minimumDecisionProfitPaise: asPaise(0),
      minimumDecisionMarginBps: 0,
      minimumCashRoiBps: 0,
    },
  };

  const result = evaluateBaseScenario(scenario);

  assert.equal(result.keptContributionPaise, 22_703);
  assert.equal(result.decisionProfitPaise, 22_703);
});

test("unknown material evidence produces WATCH, never PASS", () => {
  const scenario: EconomicScenario = {
    ...strategyExample(),
    evidence: {
      feesKnown: false,
      taxTreatmentKnown: true,
      billableWeightAndZoneKnown: true,
    },
  };

  const result = evaluateCandidate(scenario);

  assert.equal(result.status, "WATCH");
  assert.ok(result.reasons.includes("MATERIAL_FEES_UNKNOWN"));
});

test("higher failed-order probability can reject an otherwise attractive SKU", () => {
  const scenario: EconomicScenario = {
    ...strategyExample(),
    outcomes: [
      {
        kind: "kept",
        probabilityPpm: 650_000,
      },
      {
        kind: "rto",
        probabilityPpm: 200_000,
        contributionPaise: asPaise(-15_000),
      },
      {
        kind: "customer_return",
        probabilityPpm: 150_000,
        contributionPaise: asPaise(-19_000),
      },
    ],
  };

  const result = evaluateBaseScenario(scenario);

  assert.equal(result.status, "REJECT");
  assert.ok(
    result.reasons.includes("DECISION_PROFIT_BELOW_MINIMUM"),
  );
});

test("rejects invalid outcome probabilities instead of normalizing silently", () => {
  const scenario: EconomicScenario = {
    ...strategyExample(),
    outcomes: [
      {
        kind: "kept",
        probabilityPpm: 900_000,
      },
      {
        kind: "rto",
        probabilityPpm: 80_000,
        contributionPaise: asPaise(-15_000),
      },
      {
        kind: "customer_return",
        probabilityPpm: 50_000,
        contributionPaise: asPaise(-19_000),
      },
    ],
  };

  assert.throws(
    () => evaluateBaseScenario(scenario),
    /Outcome probabilities must sum to 1000000 ppm/,
  );
});

test("is deterministic for identical inputs", () => {
  const scenario = strategyExample();

  assert.deepEqual(
    evaluateCandidate(scenario),
    evaluateCandidate(scenario),
  );
});
