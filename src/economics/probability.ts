import {
  assertSafeInteger,
  rational,
  roundHalfAwayFromZero,
} from "./money.ts";
import { PROBABILITY_PPM_TOTAL } from "./types.ts";

export function assertProbabilityPpm(value: number, label: string): void {
  assertSafeInteger(value, label);

  if (value < 0 || value > PROBABILITY_PPM_TOTAL) {
    throw new Error(
      `${label} must be between 0 and ${PROBABILITY_PPM_TOTAL} ppm.`,
    );
  }
}

/**
 * Converts a probability measured inside an eligible population into an
 * unconditional probability over the full order population.
 *
 * Example: 90% of orders are delivered and 10% of delivered orders return:
 * 900,000 ppm * 100,000 ppm = 90,000 ppm unconditional returns.
 */
export function conditionalToUnconditionalPpm(
  eligiblePopulationPpm: number,
  conditionalProbabilityPpm: number,
): number {
  assertProbabilityPpm(eligiblePopulationPpm, "eligiblePopulationPpm");
  assertProbabilityPpm(
    conditionalProbabilityPpm,
    "conditionalProbabilityPpm",
  );

  return Number(
    roundHalfAwayFromZero(
      rational(
        BigInt(eligiblePopulationPpm) *
          BigInt(conditionalProbabilityPpm),
        BigInt(PROBABILITY_PPM_TOTAL),
      ),
    ),
  );
}
