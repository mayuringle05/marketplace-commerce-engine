import {
  assertCanonicalUtcTimestamp,
} from "../core/deterministic.ts";

export const DISCOVERY_SOURCE_KINDS = [
  "AMAZON",
  "FLIPKART",
  "GOOGLE_TRENDS",
  "REDDIT",
  "YOUTUBE",
  "SUPPLIER",
  "EDITORIAL",
] as const;

export type DiscoverySourceKind =
  (typeof DISCOVERY_SOURCE_KINDS)[number];

export type DiscoveryMarketplace =
  | "AMAZON_IN"
  | "FLIPKART_IN";

export interface DiscoveryPolicy {
  readonly minimumSellingPricePaise: number;
  readonly maximumSellingPricePaise: number;
  readonly maximumCompetitionScore: number;
  readonly minimumDemandScore: number;
  readonly minimumTrendConfidence: number;
  readonly minimumSourceCount: number;
  readonly minimumDistinctSourceKinds: number;
  readonly minimumEstimatedGrossSpreadBps: number;
  readonly investigateScore: number;
}

export const DEFAULT_DISCOVERY_POLICY: DiscoveryPolicy = {
  minimumSellingPricePaise: 25_000,
  maximumSellingPricePaise: 150_000,
  maximumCompetitionScore: 60,
  minimumDemandScore: 60,
  minimumTrendConfidence: 60,
  minimumSourceCount: 3,
  minimumDistinctSourceKinds: 2,
  minimumEstimatedGrossSpreadBps: 2_500,
  investigateScore: 70,
};

export interface DiscoverySource {
  readonly kind: DiscoverySourceKind;
  readonly url: string;
}

export interface DiscoveryRisk {
  readonly sizeDependent: boolean;
  readonly fitSensitive: boolean;
  readonly shadeSensitive: boolean;
  readonly fragile: boolean;
  readonly electrical: boolean;
  readonly expirySensitive: boolean;
  readonly regulated: boolean;
  readonly brandedOrIpSensitive: boolean;
}

export interface DiscoveryCandidate {
  readonly candidateId: string;
  readonly title: string;
  readonly marketplace: DiscoveryMarketplace;
  readonly category: string;
  readonly expectedSellPricePaise: number;
  readonly estimatedSupplierCostPaise: number;
  readonly competitionScore: number;
  readonly trendConfidence: number;
  readonly demand: {
    readonly reactive: number;
    readonly predictive: number;
    readonly structural: number;
  };
  readonly risk: DiscoveryRisk;
  readonly sources: readonly DiscoverySource[];
}

export interface ProductDiscoveryBatch {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly candidates: readonly DiscoveryCandidate[];
}

export interface DiscoveryEvaluation {
  readonly candidateId: string;
  readonly recommendation: "INVESTIGATE" | "HOLD" | "REJECT";
  readonly candidateScore: number;
  readonly demandScore: number;
  readonly estimatedGrossSpreadBps: number;
  readonly blockingReasons: readonly string[];
  readonly listingEligible: false;
  readonly transactionAuthority: false;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireScore(
  value: unknown,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new Error(`${label} must be an integer from 0 to 100.`);
  }
  return value;
}

function requirePaise(
  value: unknown,
  label: string,
  allowZero = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${label} must be a safe integer paise amount.`);
  }
  return value;
}

function parseRisk(value: unknown): DiscoveryRisk {
  const record = requireRecord(value, "risk");
  const keys = [
    "sizeDependent",
    "fitSensitive",
    "shadeSensitive",
    "fragile",
    "electrical",
    "expirySensitive",
    "regulated",
    "brandedOrIpSensitive",
  ] as const;
  if (!exactKeys(record, keys)) {
    throw new Error("risk does not match the exact schema.");
  }
  for (const key of keys) {
    if (typeof record[key] !== "boolean") {
      throw new Error(`risk.${key} must be boolean.`);
    }
  }
  return {
    sizeDependent: record.sizeDependent as boolean,
    fitSensitive: record.fitSensitive as boolean,
    shadeSensitive: record.shadeSensitive as boolean,
    fragile: record.fragile as boolean,
    electrical: record.electrical as boolean,
    expirySensitive: record.expirySensitive as boolean,
    regulated: record.regulated as boolean,
    brandedOrIpSensitive: record.brandedOrIpSensitive as boolean,
  };
}

function parseSources(value: unknown): readonly DiscoverySource[] {
  if (
    !Array.isArray(value) ||
    value.length > 20
  ) {
    throw new Error("sources must contain 0..20 entries.");
  }

  return value.map((item, index) => {
    const record = requireRecord(item, `sources[${index}]`);
    if (!exactKeys(record, ["kind", "url"])) {
      throw new Error(
        `sources[${index}] does not match the exact schema.`,
      );
    }
    if (
      typeof record.kind !== "string" ||
      !DISCOVERY_SOURCE_KINDS.includes(
        record.kind as DiscoverySourceKind,
      )
    ) {
      throw new Error(`sources[${index}].kind is unsupported.`);
    }
    const url = requireString(
      record.url,
      `sources[${index}].url`,
      2_000,
    );
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`sources[${index}].url must be a URL.`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(
        `sources[${index}].url must use HTTPS.`,
      );
    }
    return {
      kind: record.kind as DiscoverySourceKind,
      url,
    };
  });
}

function parseCandidate(
  value: unknown,
  index: number,
): DiscoveryCandidate {
  const record = requireRecord(value, `candidates[${index}]`);
  if (
    !exactKeys(record, [
      "candidateId",
      "title",
      "marketplace",
      "category",
      "expectedSellPricePaise",
      "estimatedSupplierCostPaise",
      "competitionScore",
      "trendConfidence",
      "demand",
      "risk",
      "sources",
    ])
  ) {
    throw new Error(
      `candidates[${index}] does not match the exact schema.`,
    );
  }

  if (
    typeof record.marketplace !== "string" ||
    !["AMAZON_IN", "FLIPKART_IN"].includes(record.marketplace)
  ) {
    throw new Error(
      `candidates[${index}].marketplace is unsupported.`,
    );
  }

  const demand = requireRecord(
    record.demand,
    `candidates[${index}].demand`,
  );
  if (
    !exactKeys(demand, [
      "reactive",
      "predictive",
      "structural",
    ])
  ) {
    throw new Error(
      `candidates[${index}].demand does not match the exact schema.`,
    );
  }

  return {
    candidateId: requireString(
      record.candidateId,
      `candidates[${index}].candidateId`,
      160,
    ),
    title: requireString(
      record.title,
      `candidates[${index}].title`,
      300,
    ),
    marketplace: record.marketplace as DiscoveryMarketplace,
    category: requireString(
      record.category,
      `candidates[${index}].category`,
      160,
    ),
    expectedSellPricePaise: requirePaise(
      record.expectedSellPricePaise,
      `candidates[${index}].expectedSellPricePaise`,
    ),
    estimatedSupplierCostPaise: requirePaise(
      record.estimatedSupplierCostPaise,
      `candidates[${index}].estimatedSupplierCostPaise`,
      true,
    ),
    competitionScore: requireScore(
      record.competitionScore,
      `candidates[${index}].competitionScore`,
    ),
    trendConfidence: requireScore(
      record.trendConfidence,
      `candidates[${index}].trendConfidence`,
    ),
    demand: {
      reactive: requireScore(
        demand.reactive,
        `candidates[${index}].demand.reactive`,
      ),
      predictive: requireScore(
        demand.predictive,
        `candidates[${index}].demand.predictive`,
      ),
      structural: requireScore(
        demand.structural,
        `candidates[${index}].demand.structural`,
      ),
    },
    risk: parseRisk(record.risk),
    sources: parseSources(record.sources),
  };
}

export function parseProductDiscoveryBatchJson(
  json: string,
): ProductDiscoveryBatch {
  if (Buffer.byteLength(json, "utf8") > 512 * 1024) {
    throw new Error("Discovery batch exceeds 512 KiB.");
  }
  const record = requireRecord(
    JSON.parse(json) as unknown,
    "discovery batch",
  );
  if (
    !exactKeys(record, [
      "schemaVersion",
      "generatedAt",
      "candidates",
    ]) ||
    record.schemaVersion !== 1 ||
    typeof record.generatedAt !== "string" ||
    !Array.isArray(record.candidates) ||
    record.candidates.length === 0 ||
    record.candidates.length > 100
  ) {
    throw new Error(
      "Discovery batch does not match exact schema version 1.",
    );
  }
  assertCanonicalUtcTimestamp(
    record.generatedAt,
    "generatedAt",
  );

  return {
    schemaVersion: 1,
    generatedAt: record.generatedAt,
    candidates: record.candidates.map(parseCandidate),
  };
}

function estimateGrossSpreadBps(
  sellPaise: number,
  supplierPaise: number,
): number {
  if (supplierPaise >= sellPaise) {
    return 0;
  }
  return Number(
    (BigInt(sellPaise - supplierPaise) * 10_000n) /
      BigInt(sellPaise),
  );
}

export function evaluateDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  policy: DiscoveryPolicy = DEFAULT_DISCOVERY_POLICY,
): DiscoveryEvaluation {
  const demandScore = Math.round(
    candidate.demand.reactive * 0.4 +
      candidate.demand.predictive * 0.25 +
      candidate.demand.structural * 0.35,
  );
  const estimatedGrossSpreadBps = estimateGrossSpreadBps(
    candidate.expectedSellPricePaise,
    candidate.estimatedSupplierCostPaise,
  );
  const blockingReasons: string[] = [];

  const riskReasons: Array<
    readonly [keyof DiscoveryRisk, string]
  > = [
    ["sizeDependent", "SIZE_DEPENDENT"],
    ["fitSensitive", "FIT_SENSITIVE"],
    ["shadeSensitive", "SHADE_SENSITIVE"],
    ["fragile", "FRAGILE"],
    ["electrical", "ELECTRICAL"],
    ["expirySensitive", "EXPIRY_SENSITIVE"],
    ["regulated", "REGULATED"],
    ["brandedOrIpSensitive", "BRAND_OR_IP_RISK"],
  ];
  for (const [riskKey, reason] of riskReasons) {
    if (candidate.risk[riskKey]) {
      blockingReasons.push(reason);
    }
  }

  if (
    candidate.expectedSellPricePaise <
      policy.minimumSellingPricePaise ||
    candidate.expectedSellPricePaise >
      policy.maximumSellingPricePaise
  ) {
    blockingReasons.push("SELLING_PRICE_OUTSIDE_POLICY");
  }
  if (
    candidate.competitionScore >
    policy.maximumCompetitionScore
  ) {
    blockingReasons.push("COMPETITION_TOO_HIGH");
  }
  if (demandScore < policy.minimumDemandScore) {
    blockingReasons.push("DEMAND_TOO_WEAK");
  }
  if (
    candidate.trendConfidence <
    policy.minimumTrendConfidence
  ) {
    blockingReasons.push("TREND_CONFIDENCE_TOO_LOW");
  }
  if (candidate.estimatedSupplierCostPaise <= 0) {
    blockingReasons.push("SUPPLIER_COST_UNVERIFIED");
  } else if (
    estimatedGrossSpreadBps <
    policy.minimumEstimatedGrossSpreadBps
  ) {
    blockingReasons.push("ESTIMATED_SPREAD_TOO_LOW");
  }

  const distinctKinds = new Set(
    candidate.sources.map((source) => source.kind),
  );
  if (candidate.sources.length < policy.minimumSourceCount) {
    blockingReasons.push("INSUFFICIENT_SOURCE_COUNT");
  }
  if (
    distinctKinds.size <
    policy.minimumDistinctSourceKinds
  ) {
    blockingReasons.push("INSUFFICIENT_SOURCE_DIVERSITY");
  }

  const requiredMarketplaceKind =
    candidate.marketplace === "AMAZON_IN"
      ? "AMAZON"
      : "FLIPKART";
  if (!distinctKinds.has(requiredMarketplaceKind)) {
    blockingReasons.push("MARKETPLACE_EVIDENCE_MISSING");
  }
  if (!distinctKinds.has("SUPPLIER")) {
    blockingReasons.push("SUPPLIER_EVIDENCE_MISSING");
  }
  if (
    !candidate.sources.some((source) =>
      [
        "AMAZON",
        "FLIPKART",
        "GOOGLE_TRENDS",
        "SUPPLIER",
        "EDITORIAL",
      ].includes(source.kind),
    )
  ) {
    blockingReasons.push("NON_COMMUNITY_EVIDENCE_MISSING");
  }

  const competitionAdvantage =
    100 - candidate.competitionScore;
  const spreadScore = Math.min(
    100,
    Math.floor(estimatedGrossSpreadBps / 50),
  );
  const candidateScore = Math.round(
    demandScore * 0.45 +
      competitionAdvantage * 0.3 +
      candidate.trendConfidence * 0.15 +
      spreadScore * 0.1,
  );

  return {
    candidateId: candidate.candidateId,
    recommendation:
      blockingReasons.length > 0
        ? "REJECT"
        : candidateScore >= policy.investigateScore
          ? "INVESTIGATE"
          : "HOLD",
    candidateScore,
    demandScore,
    estimatedGrossSpreadBps,
    blockingReasons,
    listingEligible: false,
    transactionAuthority: false,
  };
}
