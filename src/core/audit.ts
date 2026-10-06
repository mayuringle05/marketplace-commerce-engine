import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, deterministicId } from "./deterministic.ts";

export interface AuditInput {
  readonly eventType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export function appendAuditEvent(
  database: DatabaseSync,
  input: AuditInput,
): string {
  const payloadJson = canonicalJson(input.payload);
  const id = deterministicId(
    "audit",
    input.eventType,
    input.subjectType,
    input.subjectId,
    input.occurredAt,
    payloadJson,
  );

  database
    .prepare(
      `
        INSERT OR IGNORE INTO audit_events (
          id,
          event_type,
          subject_type,
          subject_id,
          payload_json,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      input.eventType,
      input.subjectType,
      input.subjectId,
      payloadJson,
      input.occurredAt,
    );

  return id;
}
