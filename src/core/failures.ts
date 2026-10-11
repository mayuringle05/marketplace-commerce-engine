import { MarketplaceRateLimitError } from "../marketplace/read-sync.ts";

export type FailureClass =
  | "SAFE_READ_RETRY"
  | "AUTH_REQUIRED"
  | "RATE_LIMIT"
  | "EXPLICIT_REJECTION"
  | "UNKNOWN_SIDE_EFFECT"
  | "VALIDATION_FAILURE"
  | "POLICY_BLOCK";

export class ClassifiedFailure extends Error {
  readonly failureClass: FailureClass;

  constructor(
    failureClass: FailureClass,
    message: string,
  ) {
    super(message);
    this.failureClass = failureClass;
  }
}

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof MarketplaceRateLimitError) {
    return "RATE_LIMIT";
  }

  if (error instanceof ClassifiedFailure) {
    return error.failureClass;
  }

  return "VALIDATION_FAILURE";
}

export function canAutomaticallyRetry(
  failureClass: FailureClass,
): boolean {
  return (
    failureClass === "SAFE_READ_RETRY" ||
    failureClass === "RATE_LIMIT"
  );
}
