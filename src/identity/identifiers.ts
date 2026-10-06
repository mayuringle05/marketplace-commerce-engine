export type IdentifierType =
  | "GTIN8"
  | "GTIN12"
  | "GTIN13"
  | "GTIN14"
  | "ISBN10"
  | "ISBN13"
  | "MPN";

export interface NormalizedIdentifier {
  readonly type: IdentifierType;
  readonly value: string;
  readonly valid: boolean;
  readonly reason:
    | "VALID"
    | "INVALID_LENGTH"
    | "INVALID_CHARACTERS"
    | "INVALID_CHECK_DIGIT"
    | "INVALID_ISBN13_PREFIX"
    | "EMPTY";
}

const GTIN_LENGTHS: Readonly<Record<Exclude<IdentifierType, "ISBN10" | "ISBN13" | "MPN">, number>> = {
  GTIN8: 8,
  GTIN12: 12,
  GTIN13: 13,
  GTIN14: 14,
};

function compactDigits(value: string): string {
  return value.normalize("NFKC").replace(/[\s-]+/g, "");
}

function normalizeTextToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function gtinCheckDigit(body: string): number {
  let total = 0;

  for (let index = body.length - 1, offset = 0; index >= 0; index -= 1, offset += 1) {
    const digit = Number(body[index]);
    total += digit * (offset % 2 === 0 ? 3 : 1);
  }

  return (10 - (total % 10)) % 10;
}

function validateGtin(value: string, expectedLength: number): NormalizedIdentifier["reason"] {
  if (value.length !== expectedLength) {
    return "INVALID_LENGTH";
  }
  if (!/^\d+$/.test(value)) {
    return "INVALID_CHARACTERS";
  }

  const expected = gtinCheckDigit(value.slice(0, -1));
  const actual = Number(value.at(-1));

  return expected === actual ? "VALID" : "INVALID_CHECK_DIGIT";
}

function validateIsbn10(value: string): NormalizedIdentifier["reason"] {
  if (value.length !== 10) {
    return "INVALID_LENGTH";
  }
  if (!/^\d{9}[\dX]$/.test(value)) {
    return "INVALID_CHARACTERS";
  }

  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const character = value[index];
    if (character === undefined) {
      throw new Error("Unexpected ISBN10 index.");
    }
    const digit = character === "X" ? 10 : Number(character);
    sum += (index + 1) * digit;
  }

  return sum % 11 === 0 ? "VALID" : "INVALID_CHECK_DIGIT";
}

export function normalizeIdentifier(
  type: IdentifierType,
  rawValue: string,
): NormalizedIdentifier {
  if (type === "MPN") {
    const value = normalizeTextToken(rawValue);
    return {
      type,
      value,
      valid: value.length > 0,
      reason: value.length > 0 ? "VALID" : "EMPTY",
    };
  }

  const compact = compactDigits(rawValue).toUpperCase();

  if (type === "ISBN10") {
    const reason = validateIsbn10(compact);
    return {
      type,
      value: compact,
      valid: reason === "VALID",
      reason,
    };
  }

  if (type === "ISBN13") {
    const baseReason = validateGtin(compact, 13);
    const reason =
      baseReason === "VALID" && !/^(978|979)/.test(compact)
        ? "INVALID_ISBN13_PREFIX"
        : baseReason;

    return {
      type,
      value: compact,
      valid: reason === "VALID",
      reason,
    };
  }

  const reason = validateGtin(compact, GTIN_LENGTHS[type]);
  return {
    type,
    value: compact,
    valid: reason === "VALID",
    reason,
  };
}

export function isbn10ToIsbn13(isbn10: string): string | null {
  const normalized = normalizeIdentifier("ISBN10", isbn10);
  if (!normalized.valid) {
    return null;
  }

  const body = `978${normalized.value.slice(0, 9)}`;
  return `${body}${gtinCheckDigit(body)}`;
}

export function toGlobalTradeKey(
  identifier: NormalizedIdentifier,
): string | null {
  if (!identifier.valid || identifier.type === "MPN") {
    return null;
  }

  if (identifier.type === "ISBN10") {
    const isbn13 = isbn10ToIsbn13(identifier.value);
    return isbn13 === null ? null : `GTIN14:${isbn13.padStart(14, "0")}`;
  }

  return `GTIN14:${identifier.value.padStart(14, "0")}`;
}

export function normalizeComparableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = normalizeTextToken(value);
  return normalized.length > 0 ? normalized : null;
}
