export type MonitoringClass =
  | "ORDER_OR_QUOTE_CRITICAL"
  | "ACTIVE_VOLATILE"
  | "ACTIVE_NORMAL"
  | "STABLE_LOCKED"
  | "WATCHLIST"
  | "DISCOVERY"
  | "SEASONAL_NEAR"
  | "SEASONAL_FAR";

export function monitoringCadenceSeconds(
  monitoringClass: MonitoringClass,
): number {
  switch (monitoringClass) {
    case "ORDER_OR_QUOTE_CRITICAL":
      return 0;
    case "ACTIVE_VOLATILE":
      return 5 * 60;
    case "ACTIVE_NORMAL":
      return 15 * 60;
    case "STABLE_LOCKED":
      return 30 * 60;
    case "WATCHLIST":
      return 4 * 60 * 60;
    case "DISCOVERY":
    case "SEASONAL_NEAR":
      return 24 * 60 * 60;
    case "SEASONAL_FAR":
      return 7 * 24 * 60 * 60;
  }
}

export function boundedBackoffSeconds(
  attempt: number,
  retryAfterSeconds: number | null = null,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer.");
  }

  if (retryAfterSeconds !== null) {
    if (
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 0
    ) {
      throw new Error(
        "retryAfterSeconds must be a non-negative integer.",
      );
    }
    return retryAfterSeconds;
  }

  const exponential = Math.min(2 ** (attempt - 1) * 5, 60 * 60);
  return exponential;
}

export interface CircuitBreakerInput {
  readonly consecutiveFailures: number;
  readonly unresolvedOperationalExceptions: number;
}

export function circuitBreakerOpen(
  input: CircuitBreakerInput,
): boolean {
  if (
    !Number.isSafeInteger(input.consecutiveFailures) ||
    input.consecutiveFailures < 0 ||
    !Number.isSafeInteger(
      input.unresolvedOperationalExceptions,
    ) ||
    input.unresolvedOperationalExceptions < 0
  ) {
    throw new Error("Circuit breaker counters must be non-negative.");
  }

  return (
    input.consecutiveFailures >= 5 ||
    input.unresolvedOperationalExceptions >= 3
  );
}
