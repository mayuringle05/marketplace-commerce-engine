import type { DatabaseSync } from "node:sqlite";

export type OfferFreshnessState =
  | "FRESH"
  | "STALE"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "OUT_OF_STOCK"
  | "MISSING";

export interface OfferFreshnessPolicy {
  readonly maximumObservationAgeSeconds: number;
}

export interface SourceOfferSnapshot {
  readonly id: string;
  readonly supplierId: string;
  readonly productId: string;
  readonly supplierSku: string;
  readonly grossCostPaise: bigint;
  readonly allocatedUnits: bigint;
  readonly availableUnits: bigint;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly observedAt: string;
  readonly sourceVersion: string;
  readonly sourceRef: string;
}

export interface OfferFreshnessDecision {
  readonly state: OfferFreshnessState;
  readonly exposable: boolean;
  readonly ageSeconds: number | null;
  readonly offer: SourceOfferSnapshot | null;
}

function parseCanonicalUtc(
  value: string,
  label: string,
): number {
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new Error(
      `${label} must be a canonical UTC ISO timestamp.`,
    );
  }

  return parsed.getTime();
}

function assertPolicy(policy: OfferFreshnessPolicy): void {
  if (
    !Number.isSafeInteger(policy.maximumObservationAgeSeconds) ||
    policy.maximumObservationAgeSeconds < 0
  ) {
    throw new Error(
      "maximumObservationAgeSeconds must be a non-negative safe integer.",
    );
  }
}

export function evaluateOfferFreshness(
  offer: SourceOfferSnapshot | null,
  asOf: string,
  policy: OfferFreshnessPolicy,
): OfferFreshnessDecision {
  assertPolicy(policy);
  const asOfMs = parseCanonicalUtc(asOf, "asOf");

  if (offer === null) {
    return {
      state: "MISSING",
      exposable: false,
      ageSeconds: null,
      offer: null,
    };
  }

  const observedAtMs = parseCanonicalUtc(
    offer.observedAt,
    "offer.observedAt",
  );
  const validFromMs = parseCanonicalUtc(
    offer.validFrom,
    "offer.validFrom",
  );
  const validUntilMs = parseCanonicalUtc(
    offer.validUntil,
    "offer.validUntil",
  );

  if (observedAtMs > asOfMs) {
    throw new Error(
      "offer.observedAt cannot be after the evaluation timestamp.",
    );
  }

  const ageMilliseconds = asOfMs - observedAtMs;
  const ageSeconds = Math.floor(ageMilliseconds / 1_000);

  if (asOfMs < validFromMs) {
    return {
      state: "NOT_YET_VALID",
      exposable: false,
      ageSeconds,
      offer,
    };
  }

  if (asOfMs >= validUntilMs) {
    return {
      state: "EXPIRED",
      exposable: false,
      ageSeconds,
      offer,
    };
  }

  if (
    ageMilliseconds >
    policy.maximumObservationAgeSeconds * 1_000
  ) {
    return {
      state: "STALE",
      exposable: false,
      ageSeconds,
      offer,
    };
  }

  if (offer.availableUnits <= 0n) {
    return {
      state: "OUT_OF_STOCK",
      exposable: false,
      ageSeconds,
      offer,
    };
  }

  return {
    state: "FRESH",
    exposable: true,
    ageSeconds,
    offer,
  };
}

interface SourceOfferRow {
  readonly id: string;
  readonly supplier_id: string;
  readonly product_id: string;
  readonly supplier_sku: string;
  readonly gross_cost_paise: bigint;
  readonly allocated_units: bigint;
  readonly available_units: bigint;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly observed_at: string;
  readonly source_version: string;
  readonly source_ref: string;
}

function toSnapshot(row: SourceOfferRow): SourceOfferSnapshot {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    productId: row.product_id,
    supplierSku: row.supplier_sku,
    grossCostPaise: row.gross_cost_paise,
    allocatedUnits: row.allocated_units,
    availableUnits: row.available_units,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    observedAt: row.observed_at,
    sourceVersion: row.source_version,
    sourceRef: row.source_ref,
  };
}

export function getLatestSourceOffer(
  database: DatabaseSync,
  supplierId: string,
  supplierSku: string,
): SourceOfferSnapshot | null {
  const row = database
    .prepare(
      `
        SELECT
          id,
          supplier_id,
          product_id,
          supplier_sku,
          gross_cost_paise,
          allocated_units,
          available_units,
          valid_from,
          valid_until,
          observed_at,
          source_version,
          source_ref
        FROM source_offers
        WHERE supplier_id = ?
          AND supplier_sku = ?
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(supplierId, supplierSku) as SourceOfferRow | undefined;

  return row === undefined ? null : toSnapshot(row);
}

export function evaluateLatestSourceOffer(
  database: DatabaseSync,
  supplierId: string,
  supplierSku: string,
  asOf: string,
  policy: OfferFreshnessPolicy,
): OfferFreshnessDecision {
  return evaluateOfferFreshness(
    getLatestSourceOffer(database, supplierId, supplierSku),
    asOf,
    policy,
  );
}
