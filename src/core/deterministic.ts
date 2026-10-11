import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite numbers are not allowed in canonical JSON.");
    }
    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }

  throw new Error(
    `Unsupported canonical JSON value type: ${typeof value}`,
  );
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicId(
  prefix: string,
  ...parts: readonly string[]
): string {
  const digest = sha256Hex(parts.join("\u001f"));
  return `${prefix}_${digest.slice(0, 32)}`;
}

export function assertCanonicalUtcTimestamp(
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
