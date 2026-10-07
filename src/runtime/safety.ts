import type { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "../core/deterministic.ts";

export interface RuntimeSafetyState {
  readonly stopNewExposure: boolean;
  readonly reason: string;
}

export function initializeRuntimeSafety(
  database: DatabaseSync,
  at: string,
): void {
  database
    .prepare(
      `
        INSERT INTO runtime_state (
          state_key,
          value_json,
          version,
          updated_at
        ) VALUES ('safety', ?, 1, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          value_json = excluded.value_json,
          version = runtime_state.version + 1,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      canonicalJson({
        stopNewExposure: true,
        reason: "STARTUP_RECONCILIATION_REQUIRED",
      }),
      at,
    );
}

export function setStopNewExposure(
  database: DatabaseSync,
  stopNewExposure: boolean,
  reason: string,
  at: string,
): void {
  database
    .prepare(
      `
        INSERT INTO runtime_state (
          state_key,
          value_json,
          version,
          updated_at
        ) VALUES ('safety', ?, 1, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          value_json = excluded.value_json,
          version = runtime_state.version + 1,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      canonicalJson({
        stopNewExposure,
        reason,
      }),
      at,
    );
}

export function readRuntimeSafety(
  database: DatabaseSync,
): RuntimeSafetyState {
  const row = database
    .prepare(
      "SELECT value_json FROM runtime_state WHERE state_key = 'safety'",
    )
    .get() as { value_json: string } | undefined;

  if (row === undefined) {
    return {
      stopNewExposure: true,
      reason: "UNINITIALIZED_RUNTIME",
    };
  }

  const parsed = JSON.parse(row.value_json) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("stopNewExposure" in parsed) ||
    !("reason" in parsed)
  ) {
    throw new Error("Invalid runtime safety state.");
  }

  const record = parsed as {
    stopNewExposure: unknown;
    reason: unknown;
  };

  if (
    typeof record.stopNewExposure !== "boolean" ||
    typeof record.reason !== "string"
  ) {
    throw new Error("Invalid runtime safety state.");
  }

  return {
    stopNewExposure: record.stopNewExposure,
    reason: record.reason,
  };
}
