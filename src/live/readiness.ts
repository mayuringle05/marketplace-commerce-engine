export const GATE0_FIELDS = [
  "legalSellerEntity",
  "taxRegimeConfirmed",
  "marketplaceSellerAccountApproved",
  "currentRateCardCaptured",
  "officialApiAccessApproved",
  "supplierSelected",
  "supplierLegalIdentityVerified",
  "supplierInvoiceVerified",
  "candidateQuotesObtained",
  "allocationAndValidityDocumented",
  "priceLockTermsDocumented",
  "singleUnitDispatchProven",
  "dispatchLocationApproved",
  "returnRouteApproved",
  "packageDataAvailable",
  "cutoffsDocumented",
  "paymentTermsDocumented",
  "capitalAndReservesSet",
  "operatorCoverageSet",
] as const;

export type Gate0Field = (typeof GATE0_FIELDS)[number];

export type Gate0Readiness = Readonly<Record<Gate0Field, boolean>>;

export interface LiveReadinessDecision {
  readonly ready: boolean;
  readonly missing: readonly Gate0Field[];
}

export function evaluateLiveReadiness(
  readiness: Gate0Readiness,
): LiveReadinessDecision {
  const missing = GATE0_FIELDS.filter(
    (field) => readiness[field] !== true,
  );

  return {
    ready: missing.length === 0,
    missing,
  };
}

export function assertLiveMutationAllowed(
  readiness: Gate0Readiness,
): void {
  const decision = evaluateLiveReadiness(readiness);
  if (!decision.ready) {
    throw new Error(
      `Live mutation blocked by Gate 0: ${decision.missing.join(", ")}`,
    );
  }
}

export function parseGate0ReadinessJson(
  json: string,
): Gate0Readiness {
  const value = JSON.parse(json) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Gate 0 readiness must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  const output = {} as Record<Gate0Field, boolean>;

  for (const field of GATE0_FIELDS) {
    if (typeof record[field] !== "boolean") {
      throw new Error(`Gate 0 field ${field} must be boolean.`);
    }
    output[field] = record[field];
  }

  return output;
}
