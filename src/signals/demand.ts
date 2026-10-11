import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
} from "../core/deterministic.ts";

export type DemandMode =
  | "REACTIVE"
  | "PREDICTIVE"
  | "STRUCTURAL";

export interface DemandSignalInput {
  readonly subjectKey: string;
  readonly mode: DemandMode;
  readonly sourceRef: string;
  readonly score: number;
  readonly observedAt: string;
  readonly evidence: unknown;
}

export interface AggregatedDemand {
  readonly reactive: number;
  readonly predictive: number;
  readonly structural: number;
  readonly evidenceCount: number;
}

function assertScore(score: number): void {
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) {
    throw new Error("Demand signal score must be an integer 0..100.");
  }
}

export function recordDemandSignal(
  database: DatabaseSync,
  input: DemandSignalInput,
): string {
  assertScore(input.score);
  assertCanonicalUtcTimestamp(input.observedAt, "observedAt");

  const payload = canonicalJson({
    score: input.score,
    evidence: input.evidence,
  });
  const id = deterministicId(
    "signal",
    input.mode,
    input.subjectKey,
    input.sourceRef,
    input.observedAt,
  );

  database
    .prepare(
      `
        INSERT OR IGNORE INTO signals_events (
          id,
          signal_type,
          subject_key,
          payload_json,
          source_ref,
          observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.mode,
      input.subjectKey,
      payload,
      input.sourceRef,
      input.observedAt,
    );

  return id;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return Math.round(
    values.reduce((total, value) => total + value, 0) /
      values.length,
  );
}

export function aggregateDemandSignals(
  database: DatabaseSync,
  subjectKey: string,
  asOf: string,
  maximumAgeSeconds: number,
): AggregatedDemand {
  const asOfMs = assertCanonicalUtcTimestamp(asOf, "asOf");
  if (
    !Number.isSafeInteger(maximumAgeSeconds) ||
    maximumAgeSeconds < 0
  ) {
    throw new Error(
      "maximumAgeSeconds must be a non-negative integer.",
    );
  }

  const cutoff = new Date(
    asOfMs - maximumAgeSeconds * 1_000,
  ).toISOString();

  const rows = database
    .prepare(
      `
        SELECT signal_type, payload_json, observed_at
        FROM signals_events
        WHERE subject_key = ?
          AND observed_at >= ?
          AND observed_at <= ?
        ORDER BY observed_at, id
      `,
    )
    .all(subjectKey, cutoff, asOf) as Array<{
    signal_type: DemandMode;
    payload_json: string;
    observed_at: string;
  }>;

  const scores: Record<DemandMode, number[]> = {
    REACTIVE: [],
    PREDICTIVE: [],
    STRUCTURAL: [],
  };

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("score" in payload)
    ) {
      throw new Error("Invalid persisted demand signal payload.");
    }

    const score = (payload as { score: unknown }).score;
    if (typeof score !== "number") {
      throw new Error("Invalid persisted demand signal score.");
    }
    assertScore(score);
    scores[row.signal_type].push(score);
  }

  return {
    reactive: average(scores.REACTIVE),
    predictive: average(scores.PREDICTIVE),
    structural: average(scores.STRUCTURAL),
    evidenceCount: rows.length,
  };
}
