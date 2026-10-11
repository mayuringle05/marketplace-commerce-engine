import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
} from "../core/deterministic.ts";

export type EconomicsMarketplace = "AMAZON_IN" | "FLIPKART_IN";

export interface MarketplaceEconomicsProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly marketplace: EconomicsMarketplace;
  readonly categoryScope: string;
  readonly verificationStatus: "PUBLIC_STANDARD" | "VERIFIED";
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly verifiedAt: string;
  readonly sourceVersion: string;
  readonly sourceRefs: readonly string[];
  readonly outputTaxRateBps: number;
  readonly supplierTaxRateBps: number;
  readonly supplierTaxRecoverable: boolean;
  readonly marketplaceFeeBps: number;
  readonly fixedMarketplaceFeePaise: number;
  readonly shippingPaise: number;
  readonly packingHandlingPaise: number;
  readonly costTaxRateBps: number;
  readonly rtoProbabilityPpm: number;
  readonly rtoCostPaise: number;
  readonly customerReturnProbabilityPpm: number;
  readonly customerReturnCostPaise: number;
  readonly feeUncertaintyPaise: number;
  readonly unmodelledPriceRiskPaise: number;
  readonly supplierRiskPaise: number;
  readonly allocatedOverheadPaise: number;
  readonly minimumDecisionProfitPaise: number;
  readonly minimumDecisionMarginBps: number;
  readonly minimumCashRoiBps: number;
  readonly availableSingleOrderLossReservePaise: number;
  readonly maxInitialStockUnits: number;
  readonly maxInitialStockCapitalPaise: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} does not match the exact schema.`);
  }
}

function text(value: unknown, label: string, max = 2_000): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function httpsUrl(value: unknown, label: string): string {
  const candidate = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  return candidate;
}

export function parseMarketplaceEconomicsProfileJson(
  json: string,
): MarketplaceEconomicsProfile {
  if (Buffer.byteLength(json, "utf8") > 128 * 1024) {
    throw new Error("Economics profile exceeds 128 KiB.");
  }
  const value = record(JSON.parse(json) as unknown, "economics profile");
  exactKeys(
    value,
    [
      "schemaVersion",
      "profileId",
      "marketplace",
      "categoryScope",
      "verificationStatus",
      "effectiveFrom",
      "effectiveUntil",
      "verifiedAt",
      "sourceVersion",
      "sourceRefs",
      "outputTaxRateBps",
      "supplierTaxRateBps",
      "supplierTaxRecoverable",
      "marketplaceFeeBps",
      "fixedMarketplaceFeePaise",
      "shippingPaise",
      "packingHandlingPaise",
      "costTaxRateBps",
      "rtoProbabilityPpm",
      "rtoCostPaise",
      "customerReturnProbabilityPpm",
      "customerReturnCostPaise",
      "feeUncertaintyPaise",
      "unmodelledPriceRiskPaise",
      "supplierRiskPaise",
      "allocatedOverheadPaise",
      "minimumDecisionProfitPaise",
      "minimumDecisionMarginBps",
      "minimumCashRoiBps",
      "availableSingleOrderLossReservePaise",
      "maxInitialStockUnits",
      "maxInitialStockCapitalPaise",
    ],
    "economics profile",
  );

  if (value.schemaVersion !== 1) {
    throw new Error("Economics profile schemaVersion must be 1.");
  }
  if (
    value.marketplace !== "AMAZON_IN" &&
    value.marketplace !== "FLIPKART_IN"
  ) {
    throw new Error("Economics profile marketplace is unsupported.");
  }
  if (
    value.verificationStatus !== "PUBLIC_STANDARD" &&
    value.verificationStatus !== "VERIFIED"
  ) {
    throw new Error(
      "Economics profile verificationStatus must be PUBLIC_STANDARD or VERIFIED.",
    );
  }
  if (typeof value.supplierTaxRecoverable !== "boolean") {
    throw new Error("supplierTaxRecoverable must be boolean.");
  }
  if (
    !Array.isArray(value.sourceRefs) ||
    value.sourceRefs.length < 1 ||
    value.sourceRefs.length > 20
  ) {
    throw new Error("sourceRefs must contain 1..20 HTTPS URLs.");
  }

  const effectiveFrom = text(value.effectiveFrom, "effectiveFrom", 64);
  const effectiveUntil = text(value.effectiveUntil, "effectiveUntil", 64);
  const verifiedAt = text(value.verifiedAt, "verifiedAt", 64);
  const fromMs = assertCanonicalUtcTimestamp(
    effectiveFrom,
    "effectiveFrom",
  );
  const untilMs = assertCanonicalUtcTimestamp(
    effectiveUntil,
    "effectiveUntil",
  );
  assertCanonicalUtcTimestamp(verifiedAt, "verifiedAt");
  if (untilMs <= fromMs) {
    throw new Error("effectiveUntil must be after effectiveFrom.");
  }

  const rtoProbabilityPpm = integer(
    value.rtoProbabilityPpm,
    "rtoProbabilityPpm",
    0,
    1_000_000,
  );
  const customerReturnProbabilityPpm = integer(
    value.customerReturnProbabilityPpm,
    "customerReturnProbabilityPpm",
    0,
    1_000_000,
  );
  if (rtoProbabilityPpm + customerReturnProbabilityPpm > 1_000_000) {
    throw new Error(
      "RTO and customer-return probabilities cannot exceed 100%.",
    );
  }

  return {
    schemaVersion: 1,
    profileId: text(value.profileId, "profileId", 160),
    marketplace: value.marketplace,
    categoryScope: text(value.categoryScope, "categoryScope", 160),
    verificationStatus: value.verificationStatus,
    effectiveFrom,
    effectiveUntil,
    verifiedAt,
    sourceVersion: text(value.sourceVersion, "sourceVersion", 300),
    sourceRefs: value.sourceRefs.map((item, index) =>
      httpsUrl(item, `sourceRefs[${index}]`),
    ),
    outputTaxRateBps: integer(
      value.outputTaxRateBps,
      "outputTaxRateBps",
      0,
      100_000,
    ),
    supplierTaxRateBps: integer(
      value.supplierTaxRateBps,
      "supplierTaxRateBps",
      0,
      100_000,
    ),
    supplierTaxRecoverable: value.supplierTaxRecoverable,
    marketplaceFeeBps: integer(
      value.marketplaceFeeBps,
      "marketplaceFeeBps",
      0,
      100_000,
    ),
    fixedMarketplaceFeePaise: integer(
      value.fixedMarketplaceFeePaise,
      "fixedMarketplaceFeePaise",
    ),
    shippingPaise: integer(value.shippingPaise, "shippingPaise"),
    packingHandlingPaise: integer(
      value.packingHandlingPaise,
      "packingHandlingPaise",
    ),
    costTaxRateBps: integer(
      value.costTaxRateBps,
      "costTaxRateBps",
      0,
      100_000,
    ),
    rtoProbabilityPpm,
    rtoCostPaise: integer(value.rtoCostPaise, "rtoCostPaise"),
    customerReturnProbabilityPpm,
    customerReturnCostPaise: integer(
      value.customerReturnCostPaise,
      "customerReturnCostPaise",
    ),
    feeUncertaintyPaise: integer(
      value.feeUncertaintyPaise,
      "feeUncertaintyPaise",
    ),
    unmodelledPriceRiskPaise: integer(
      value.unmodelledPriceRiskPaise,
      "unmodelledPriceRiskPaise",
    ),
    supplierRiskPaise: integer(
      value.supplierRiskPaise,
      "supplierRiskPaise",
    ),
    allocatedOverheadPaise: integer(
      value.allocatedOverheadPaise,
      "allocatedOverheadPaise",
    ),
    minimumDecisionProfitPaise: integer(
      value.minimumDecisionProfitPaise,
      "minimumDecisionProfitPaise",
    ),
    minimumDecisionMarginBps: integer(
      value.minimumDecisionMarginBps,
      "minimumDecisionMarginBps",
      0,
      100_000,
    ),
    minimumCashRoiBps: integer(
      value.minimumCashRoiBps,
      "minimumCashRoiBps",
      0,
      100_000,
    ),
    availableSingleOrderLossReservePaise: integer(
      value.availableSingleOrderLossReservePaise,
      "availableSingleOrderLossReservePaise",
    ),
    maxInitialStockUnits: integer(
      value.maxInitialStockUnits,
      "maxInitialStockUnits",
      1,
      1_000,
    ),
    maxInitialStockCapitalPaise: integer(
      value.maxInitialStockCapitalPaise,
      "maxInitialStockCapitalPaise",
      1,
    ),
  };
}

export function upsertMarketplaceEconomicsProfile(
  database: DatabaseSync,
  profile: MarketplaceEconomicsProfile,
  createdAt: string,
): void {
  assertCanonicalUtcTimestamp(createdAt, "createdAt");
  database
    .prepare(
      `
        INSERT INTO marketplace_economics_profiles (
          profile_id,
          marketplace,
          category_scope,
          effective_from,
          effective_until,
          verified_at,
          source_version,
          source_refs_json,
          profile_json,
          verification_status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          marketplace = excluded.marketplace,
          category_scope = excluded.category_scope,
          effective_from = excluded.effective_from,
          effective_until = excluded.effective_until,
          verified_at = excluded.verified_at,
          source_version = excluded.source_version,
          source_refs_json = excluded.source_refs_json,
          profile_json = excluded.profile_json,
          verification_status = excluded.verification_status,
          created_at = excluded.created_at
      `,
    )
    .run(
      profile.profileId,
      profile.marketplace,
      profile.categoryScope,
      profile.effectiveFrom,
      profile.effectiveUntil,
      profile.verifiedAt,
      profile.sourceVersion,
      canonicalJson(profile.sourceRefs),
      canonicalJson(profile),
      profile.verificationStatus,
      createdAt,
    );
}

export function findActiveEconomicsProfile(
  database: DatabaseSync,
  marketplace: EconomicsMarketplace,
  category: string,
  at: string,
): MarketplaceEconomicsProfile | null {
  assertCanonicalUtcTimestamp(at, "at");
  const row = database
    .prepare(
      `
        SELECT profile_json
        FROM marketplace_economics_profiles
        WHERE marketplace = ?
          AND category_scope IN (?, '*')
          AND effective_from <= ?
          AND effective_until > ?
        ORDER BY
          CASE WHEN category_scope = ? THEN 0 ELSE 1 END,
          CASE WHEN verification_status = 'VERIFIED' THEN 0 ELSE 1 END,
          verified_at DESC,
          created_at DESC
        LIMIT 1
      `,
    )
    .get(
      marketplace,
      category,
      at,
      at,
      category,
    ) as { profile_json: string } | undefined;

  return row === undefined
    ? null
    : parseMarketplaceEconomicsProfileJson(row.profile_json);
}
