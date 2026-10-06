export interface SupplierFeedPackage {
  readonly packedWeightGrams: number;
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly heightMm: number;
}

export interface SupplierFeedOffer {
  readonly productId: string;
  readonly fulfilmentRouteId: string;
  readonly supplierSku: string;
  readonly grossCostPaise: number;
  readonly taxRateBps: number;
  readonly allocatedUnits: number;
  readonly availableUnits: number;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly package: SupplierFeedPackage;
}

export interface SupplierFeed {
  readonly supplierId: string;
  readonly sourceVersion: string;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly offers: readonly SupplierFeedOffer[];
}

function asRecord(
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

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }

  return value.trim();
}

function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label}.${key} must be an integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = new Date(value);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new Error(
      `${label} must be a canonical UTC ISO timestamp.`,
    );
  }

  return value;
}

function parsePackage(
  value: unknown,
  label: string,
): SupplierFeedPackage {
  const record = asRecord(value, label);

  return {
    packedWeightGrams: requiredInteger(
      record,
      "packedWeightGrams",
      label,
      1,
    ),
    lengthMm: requiredInteger(record, "lengthMm", label, 1),
    widthMm: requiredInteger(record, "widthMm", label, 1),
    heightMm: requiredInteger(record, "heightMm", label, 1),
  };
}

function parseOffer(
  value: unknown,
  index: number,
): SupplierFeedOffer {
  const label = `offers[${index}]`;
  const record = asRecord(value, label);
  const validFrom = canonicalTimestamp(
    requiredString(record, "validFrom", label),
    `${label}.validFrom`,
  );
  const validUntil = canonicalTimestamp(
    requiredString(record, "validUntil", label),
    `${label}.validUntil`,
  );
  const allocatedUnits = requiredInteger(
    record,
    "allocatedUnits",
    label,
    0,
  );
  const availableUnits = requiredInteger(
    record,
    "availableUnits",
    label,
    0,
  );

  if (validUntil <= validFrom) {
    throw new Error(
      `${label}.validUntil must be after validFrom.`,
    );
  }

  if (availableUnits > allocatedUnits) {
    throw new Error(
      `${label}.availableUnits cannot exceed allocatedUnits.`,
    );
  }

  return {
    productId: requiredString(record, "productId", label),
    fulfilmentRouteId: requiredString(
      record,
      "fulfilmentRouteId",
      label,
    ),
    supplierSku: requiredString(record, "supplierSku", label),
    grossCostPaise: requiredInteger(
      record,
      "grossCostPaise",
      label,
      0,
    ),
    taxRateBps: requiredInteger(
      record,
      "taxRateBps",
      label,
      0,
      100_000,
    ),
    allocatedUnits,
    availableUnits,
    validFrom,
    validUntil,
    package: parsePackage(record.package, `${label}.package`),
  };
}

export function parseSupplierFeedJson(json: string): SupplierFeed {
  let value: unknown;

  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error("Supplier feed is not valid JSON.");
  }

  const record = asRecord(value, "feed");
  const supplierId = requiredString(record, "supplierId", "feed");
  const sourceVersion = requiredString(
    record,
    "sourceVersion",
    "feed",
  );
  const sourceRef = requiredString(record, "sourceRef", "feed");
  const observedAt = canonicalTimestamp(
    requiredString(record, "observedAt", "feed"),
    "feed.observedAt",
  );

  if (!Array.isArray(record.offers)) {
    throw new Error("feed.offers must be an array.");
  }

  if (record.offers.length === 0) {
    throw new Error("feed.offers must contain at least one offer.");
  }

  return {
    supplierId,
    sourceVersion,
    sourceRef,
    observedAt,
    offers: record.offers.map((offer, index) =>
      parseOffer(offer, index),
    ),
  };
}
