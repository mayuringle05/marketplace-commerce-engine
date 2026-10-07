import {
  normalizeComparableText,
  normalizeIdentifier,
  toGlobalTradeKey,
  type IdentifierType,
} from "./identifiers.ts";

export type IdentityClass = "A" | "B" | "C" | "D" | "CONFLICT";

export type IdentityReason =
  | "EXACT_GLOBAL_IDENTIFIER"
  | "EXACT_BRAND_AND_MPN"
  | "EXACT_BRAND_AND_MODEL"
  | "BRAND_SUPPORT_ONLY"
  | "NO_STRONG_IDENTITY_EVIDENCE"
  | "INVALID_ASSERTED_IDENTIFIER"
  | "GLOBAL_IDENTIFIER_CONFLICT"
  | "BRAND_CONTRADICTION"
  | "MPN_CONTRADICTION"
  | "MODEL_CONTRADICTION"
  | "MISSING_REQUIRED_ATTRIBUTES"
  | "PACK_COUNT_CONTRADICTION"
  | "VARIANT_CONTRADICTION"
  | "CONDITION_CONTRADICTION"
  | "EDITION_CONTRADICTION"
  | "REGION_CONTRADICTION";

export interface IdentityIdentifierInput {
  readonly type: IdentifierType;
  readonly value: string;
}

export interface IdentityProfile {
  readonly brand?: string | null;
  readonly model?: string | null;
  readonly mpn?: string | null;
  readonly condition?: string | null;
  readonly marketRegion?: string | null;
  readonly edition?: string | null;
  readonly variant?: string | null;
  readonly packCount?: number | null;
  readonly identifiers?: readonly IdentityIdentifierInput[];
}

export interface IdentityDecision {
  readonly classification: IdentityClass;
  readonly reasons: readonly IdentityReason[];
  readonly matchedGlobalKeys: readonly string[];
}

function normalizedIdentifierInputs(profile: IdentityProfile) {
  return (profile.identifiers ?? []).map((identifier) =>
    normalizeIdentifier(identifier.type, identifier.value),
  );
}

function assertedGlobalKeys(profile: IdentityProfile): {
  readonly keys: ReadonlySet<string>;
  readonly hasInvalidStrongIdentifier: boolean;
} {
  const normalized = normalizedIdentifierInputs(profile);
  const keys = new Set<string>();
  let hasInvalidStrongIdentifier = false;

  for (const identifier of normalized) {
    if (identifier.type === "MPN") {
      continue;
    }

    if (!identifier.valid) {
      hasInvalidStrongIdentifier = true;
      continue;
    }

    const key = toGlobalTradeKey(identifier);
    if (key !== null) {
      keys.add(key);
    }
  }

  return {
    keys,
    hasInvalidStrongIdentifier,
  };
}

function comparableEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean | null {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);

  if (normalizedLeft === null || normalizedRight === null) {
    return null;
  }

  return normalizedLeft === normalizedRight;
}

function hardContradictionReasons(
  canonical: IdentityProfile,
  observed: IdentityProfile,
): IdentityReason[] {
  const reasons: IdentityReason[] = [];

  if (comparableEqual(canonical.brand, observed.brand) === false) {
    reasons.push("BRAND_CONTRADICTION");
  }
  if (comparableEqual(canonical.mpn, observed.mpn) === false) {
    reasons.push("MPN_CONTRADICTION");
  }
  if (comparableEqual(canonical.model, observed.model) === false) {
    reasons.push("MODEL_CONTRADICTION");
  }
  if (comparableEqual(canonical.condition, observed.condition) === false) {
    reasons.push("CONDITION_CONTRADICTION");
  }
  if (comparableEqual(canonical.marketRegion, observed.marketRegion) === false) {
    reasons.push("REGION_CONTRADICTION");
  }
  if (comparableEqual(canonical.edition, observed.edition) === false) {
    reasons.push("EDITION_CONTRADICTION");
  }
  if (comparableEqual(canonical.variant, observed.variant) === false) {
    reasons.push("VARIANT_CONTRADICTION");
  }

  if (
    canonical.packCount !== null &&
    canonical.packCount !== undefined &&
    observed.packCount !== null &&
    observed.packCount !== undefined &&
    canonical.packCount !== observed.packCount
  ) {
    reasons.push("PACK_COUNT_CONTRADICTION");
  }

  return reasons;
}

function hasRequiredOperationalAttributes(
  canonical: IdentityProfile,
  observed: IdentityProfile,
): boolean {
  if (
    normalizeComparableText(observed.condition) === null ||
    normalizeComparableText(observed.marketRegion) === null ||
    observed.packCount === null ||
    observed.packCount === undefined
  ) {
    return false;
  }

  if (
    normalizeComparableText(canonical.variant) !== null &&
    normalizeComparableText(observed.variant) === null
  ) {
    return false;
  }

  if (
    normalizeComparableText(canonical.edition) !== null &&
    normalizeComparableText(observed.edition) === null
  ) {
    return false;
  }

  return true;
}

function exactBrandAndMpn(
  canonical: IdentityProfile,
  observed: IdentityProfile,
): boolean {
  return (
    comparableEqual(canonical.brand, observed.brand) === true &&
    comparableEqual(canonical.mpn, observed.mpn) === true
  );
}

function exactBrandAndModel(
  canonical: IdentityProfile,
  observed: IdentityProfile,
): boolean {
  return (
    comparableEqual(canonical.brand, observed.brand) === true &&
    comparableEqual(canonical.model, observed.model) === true
  );
}

export function classifyIdentity(
  canonical: IdentityProfile,
  observed: IdentityProfile,
): IdentityDecision {
  const contradictionReasons = hardContradictionReasons(
    canonical,
    observed,
  );

  const canonicalGlobal = assertedGlobalKeys(canonical);
  const observedGlobal = assertedGlobalKeys(observed);

  if (observedGlobal.hasInvalidStrongIdentifier) {
    return {
      classification: "CONFLICT",
      reasons: [
        ...contradictionReasons,
        "INVALID_ASSERTED_IDENTIFIER",
      ],
      matchedGlobalKeys: [],
    };
  }

  const matchedGlobalKeys = [...observedGlobal.keys].filter((key) =>
    canonicalGlobal.keys.has(key),
  );

  if (contradictionReasons.length > 0) {
    return {
      classification: "CONFLICT",
      reasons: contradictionReasons,
      matchedGlobalKeys,
    };
  }

  if (matchedGlobalKeys.length > 0) {
    return {
      classification: "A",
      reasons: ["EXACT_GLOBAL_IDENTIFIER"],
      matchedGlobalKeys: matchedGlobalKeys.sort(),
    };
  }

  if (
    canonicalGlobal.keys.size > 0 &&
    observedGlobal.keys.size > 0
  ) {
    return {
      classification: "CONFLICT",
      reasons: ["GLOBAL_IDENTIFIER_CONFLICT"],
      matchedGlobalKeys: [],
    };
  }

  if (exactBrandAndMpn(canonical, observed)) {
    if (!hasRequiredOperationalAttributes(canonical, observed)) {
      return {
        classification: "C",
        reasons: ["MISSING_REQUIRED_ATTRIBUTES"],
        matchedGlobalKeys: [],
      };
    }
    return {
      classification: "B",
      reasons: ["EXACT_BRAND_AND_MPN"],
      matchedGlobalKeys: [],
    };
  }

  if (exactBrandAndModel(canonical, observed)) {
    if (!hasRequiredOperationalAttributes(canonical, observed)) {
      return {
        classification: "C",
        reasons: ["MISSING_REQUIRED_ATTRIBUTES"],
        matchedGlobalKeys: [],
      };
    }
    return {
      classification: "B",
      reasons: ["EXACT_BRAND_AND_MODEL"],
      matchedGlobalKeys: [],
    };
  }

  if (comparableEqual(canonical.brand, observed.brand) === true) {
    return {
      classification: "C",
      reasons: ["BRAND_SUPPORT_ONLY"],
      matchedGlobalKeys: [],
    };
  }

  return {
    classification: "D",
    reasons: ["NO_STRONG_IDENTITY_EVIDENCE"],
    matchedGlobalKeys: [],
  };
}

export function isAutomationEligibleIdentityClass(
  classification: IdentityClass,
): boolean {
  return classification === "A" || classification === "B";
}
