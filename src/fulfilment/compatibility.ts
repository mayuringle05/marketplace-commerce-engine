import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
} from "../core/deterministic.ts";

export const REQUIRED_FULFILMENT_EVIDENCE = [
  "NEUTRAL_OUTER_PACKAGING",
  "NO_SUPPLIER_BRANDING",
  "SELLER_INVOICE_SUPPORTED",
  "MARKETPLACE_LABEL_SUPPORTED",
] as const;

export type FulfilmentEvidenceType =
  (typeof REQUIRED_FULFILMENT_EVIDENCE)[number];

export interface FulfilmentCompatibilityDecision {
  readonly compatible: boolean;
  readonly blockingReasons: readonly string[];
  readonly evidenceRefs: readonly string[];
}

interface EvidenceRow {
  readonly value_text: string;
  readonly source_ref: string;
}

export function evaluateFulfilmentCompatibility(
  database: DatabaseSync,
  routeId: string,
  evaluatedAt: string,
): FulfilmentCompatibilityDecision {
  assertCanonicalUtcTimestamp(evaluatedAt, "evaluatedAt");

  const route = database
    .prepare("SELECT id FROM fulfilment_routes WHERE id = ?")
    .get(routeId);
  if (route === undefined) {
    return {
      compatible: false,
      blockingReasons: ["FULFILMENT_ROUTE_NOT_FOUND"],
      evidenceRefs: [],
    };
  }

  const latest = database.prepare(
    `
      SELECT value_text, source_ref
      FROM observations
      WHERE subject_type = 'fulfilment_route'
        AND subject_id = ?
        AND observation_type = ?
        AND observed_at <= ?
      ORDER BY observed_at DESC, rowid DESC
      LIMIT 1
    `,
  );

  const blockingReasons: string[] = [];
  const evidenceRefs: string[] = [];

  for (const evidenceType of REQUIRED_FULFILMENT_EVIDENCE) {
    const row = latest.get(
      routeId,
      evidenceType,
      evaluatedAt,
    ) as EvidenceRow | undefined;

    if (row === undefined) {
      blockingReasons.push(`MISSING_${evidenceType}`);
      continue;
    }

    evidenceRefs.push(row.source_ref);
    if (row.value_text !== "VERIFIED") {
      blockingReasons.push(`${evidenceType}_NOT_VERIFIED`);
    }
  }

  return {
    compatible: blockingReasons.length === 0,
    blockingReasons,
    evidenceRefs,
  };
}
