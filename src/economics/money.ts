export type Paise = number & { readonly __paiseBrand: unique symbol };

export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const BPS_DENOMINATOR = 10_000n;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a === 0n ? 1n : a;
}

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) {
    throw new Error("Rational denominator cannot be zero.");
  }

  const sign = denominator < 0n ? -1n : 1n;
  const signedNumerator = numerator * sign;
  const positiveDenominator = denominator * sign;
  const divisor = gcd(signedNumerator, positiveDenominator);

  return {
    numerator: signedNumerator / divisor,
    denominator: positiveDenominator / divisor,
  };
}

export function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function subtract(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function multiplyRatio(
  value: Rational,
  numerator: number,
  denominator: number,
): Rational {
  assertSafeInteger(numerator, "ratio numerator");
  assertSafeInteger(denominator, "ratio denominator");

  if (denominator <= 0) {
    throw new Error("Ratio denominator must be positive.");
  }

  return rational(
    value.numerator * BigInt(numerator),
    value.denominator * BigInt(denominator),
  );
}

export function compare(left: Rational, right: Rational): number {
  const leftScaled = left.numerator * right.denominator;
  const rightScaled = right.numerator * left.denominator;

  if (leftScaled < rightScaled) {
    return -1;
  }
  if (leftScaled > rightScaled) {
    return 1;
  }
  return 0;
}

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
}

export function assertBasisPoints(value: number, label: string): void {
  assertSafeInteger(value, label);

  if (value < 0 || value > 100_000) {
    throw new Error(`${label} must be between 0 and 100000 basis points.`);
  }
}

export function asPaise(value: number): Paise {
  assertSafeInteger(value, "paise");
  return value as Paise;
}

export function fromPaise(value: Paise): Rational {
  return rational(BigInt(value));
}

export function netFromGross(
  grossPaise: Paise,
  taxRateBps: number,
): Rational {
  assertBasisPoints(taxRateBps, "taxRateBps");

  return rational(
    BigInt(grossPaise) * BPS_DENOMINATOR,
    BPS_DENOMINATOR + BigInt(taxRateBps),
  );
}

export function grossFromNet(
  netPaise: Paise,
  taxRateBps: number,
): Rational {
  assertBasisPoints(taxRateBps, "taxRateBps");

  return rational(
    BigInt(netPaise) * (BPS_DENOMINATOR + BigInt(taxRateBps)),
    BPS_DENOMINATOR,
  );
}

export function roundHalfAwayFromZero(value: Rational): bigint {
  const negative = value.numerator < 0n;
  const absoluteNumerator = negative ? -value.numerator : value.numerator;
  const quotient = absoluteNumerator / value.denominator;
  const remainder = absoluteNumerator % value.denominator;
  const rounded =
    remainder * 2n >= value.denominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

export function toPaise(value: Rational): Paise {
  const rounded = roundHalfAwayFromZero(value);
  const numeric = Number(rounded);

  if (!Number.isSafeInteger(numeric)) {
    throw new Error("Rounded monetary value exceeds JavaScript safe integer range.");
  }

  return numeric as Paise;
}

export function ratioToBps(
  numerator: Rational,
  denominator: Rational,
): number {
  if (denominator.numerator <= 0n) {
    throw new Error("Ratio denominator must be positive.");
  }

  const ratio = rational(
    numerator.numerator * denominator.denominator * BPS_DENOMINATOR,
    numerator.denominator * denominator.numerator,
  );

  const rounded = roundHalfAwayFromZero(ratio);
  const numeric = Number(rounded);

  if (!Number.isSafeInteger(numeric)) {
    throw new Error("Basis-point ratio exceeds JavaScript safe integer range.");
  }

  return numeric;
}

export function ratioAtLeastBps(
  numerator: Rational,
  denominator: Rational,
  minimumBps: number,
): boolean {
  assertBasisPoints(minimumBps, "minimumBps");

  if (denominator.numerator <= 0n) {
    return false;
  }

  const left =
    numerator.numerator *
    denominator.denominator *
    BPS_DENOMINATOR;
  const right =
    denominator.numerator *
    numerator.denominator *
    BigInt(minimumBps);

  return left >= right;
}

export function scaleIntegerByBps(value: number, multiplierBps: number): number {
  assertSafeInteger(value, "scaled value");
  assertBasisPoints(multiplierBps, "multiplierBps");

  const scaled = rational(
    BigInt(value) * BigInt(multiplierBps),
    BPS_DENOMINATOR,
  );
  const rounded = roundHalfAwayFromZero(scaled);
  const numeric = Number(rounded);

  if (!Number.isSafeInteger(numeric)) {
    throw new Error("Scaled integer exceeds JavaScript safe integer range.");
  }

  return numeric;
}
