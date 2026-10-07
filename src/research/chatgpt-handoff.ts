import {
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";

export interface ResearchPacket {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly opportunities: readonly {
    readonly id: string;
    readonly productId: string;
    readonly marketplace: string;
    readonly state: string;
    readonly opportunityScore: number;
    readonly demandScore: number;
    readonly decisionProfitPaise: number;
    readonly blockingReasonsJson: string;
  }[];
}

export interface ChatGptDecision {
  readonly schemaVersion: 1;
  readonly decisionType: "RESEARCH_RECOMMENDATION";
  readonly subjectId: string;
  readonly inputHash: string;
  readonly recommendation: "INVESTIGATE" | "HOLD" | "IGNORE";
  readonly rationale: string;
}

export function buildResearchPacket(
  database: DatabaseSync,
  generatedAt: string,
  limit = 20,
): ResearchPacket {
  assertCanonicalUtcTimestamp(generatedAt, "generatedAt");
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Research packet limit must be 1..100.");
  }

  const rows = database
    .prepare(
      `
        SELECT
          id,
          product_id,
          marketplace,
          decision_state,
          opportunity_score,
          demand_score,
          decision_profit_paise,
          blocking_reasons_json
        FROM opportunities
        ORDER BY opportunity_score DESC, id
        LIMIT ?
      `,
    )
    .all(limit) as Array<{
    id: string;
    product_id: string;
    marketplace: string;
    decision_state: string;
    opportunity_score: bigint;
    demand_score: bigint;
    decision_profit_paise: bigint;
    blocking_reasons_json: string;
  }>;

  return {
    schemaVersion: 1,
    generatedAt,
    opportunities: rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      marketplace: row.marketplace,
      state: row.decision_state,
      opportunityScore: Number(row.opportunity_score),
      demandScore: Number(row.demand_score),
      decisionProfitPaise: Number(row.decision_profit_paise),
      blockingReasonsJson: row.blocking_reasons_json,
    })),
  };
}

export function writeResearchPacketFile(
  database: DatabaseSync,
  path: string,
  packet: ResearchPacket,
  expiresAt: string,
): string {
  const generatedMs = assertCanonicalUtcTimestamp(
    packet.generatedAt,
    "generatedAt",
  );
  const expiresMs = assertCanonicalUtcTimestamp(
    expiresAt,
    "expiresAt",
  );
  if (
    expiresMs <= generatedMs ||
    expiresMs - generatedMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error(
      "Research packet expiry must be within 24 hours after generation.",
    );
  }

  const json = canonicalJson(packet);
  if (Buffer.byteLength(json, "utf8") > 256 * 1024) {
    throw new Error("Research packet exceeds 256 KiB.");
  }

  const inputHash = sha256Hex(json);
  const subjects = packet.opportunities.map(
    (opportunity) => opportunity.id,
  );

  database
    .prepare(
      `
        INSERT INTO research_packets (
          input_hash,
          schema_version,
          generated_at,
          expires_at,
          subject_ids_json,
          packet_json
        ) VALUES (?, 1, ?, ?, ?, ?)
        ON CONFLICT(input_hash) DO NOTHING
      `,
    )
    .run(
      inputHash,
      packet.generatedAt,
      expiresAt,
      canonicalJson(subjects),
      json,
    );

  writeFileSync(path, `${json}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return inputHash;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function parseChatGptDecisionJson(
  json: string,
): ChatGptDecision {
  if (Buffer.byteLength(json, "utf8") > 64 * 1024) {
    throw new Error("Decision exceeds 64 KiB.");
  }

  const value = JSON.parse(json) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Decision must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "schemaVersion",
      "decisionType",
      "subjectId",
      "inputHash",
      "recommendation",
      "rationale",
    ]) ||
    record.schemaVersion !== 1 ||
    record.decisionType !== "RESEARCH_RECOMMENDATION" ||
    typeof record.subjectId !== "string" ||
    record.subjectId.trim().length === 0 ||
    typeof record.inputHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.inputHash) ||
    typeof record.recommendation !== "string" ||
    !["INVESTIGATE", "HOLD", "IGNORE"].includes(
      record.recommendation,
    ) ||
    typeof record.rationale !== "string" ||
    record.rationale.length === 0 ||
    record.rationale.length > 2_000
  ) {
    throw new Error("Decision does not match exact schema version 1.");
  }

  return {
    schemaVersion: 1,
    decisionType: "RESEARCH_RECOMMENDATION",
    subjectId: record.subjectId,
    inputHash: record.inputHash,
    recommendation: record.recommendation as
      | "INVESTIGATE"
      | "HOLD"
      | "IGNORE",
    rationale: record.rationale,
  };
}

export function importChatGptDecisionFile(
  database: DatabaseSync,
  path: string,
  importedAt: string,
): string {
  assertCanonicalUtcTimestamp(importedAt, "importedAt");
  if (statSync(path).size > 64 * 1024) {
    throw new Error("Decision file exceeds 64 KiB.");
  }

  const decision = parseChatGptDecisionJson(
    readFileSync(path, "utf8"),
  );

  const packet = database
    .prepare(
      `
        SELECT expires_at, subject_ids_json
        FROM research_packets
        WHERE input_hash = ?
      `,
    )
    .get(decision.inputHash) as
    | {
        expires_at: string;
        subject_ids_json: string;
      }
    | undefined;

  if (
    packet === undefined ||
    importedAt >= packet.expires_at
  ) {
    throw new Error(
      "Decision does not reference a current exported research packet.",
    );
  }

  const subjects = JSON.parse(
    packet.subject_ids_json,
  ) as unknown;
  if (
    !Array.isArray(subjects) ||
    !subjects.every((value) => typeof value === "string") ||
    !subjects.includes(decision.subjectId)
  ) {
    throw new Error(
      "Decision subject was not present in the exported packet.",
    );
  }

  const opportunity = database
    .prepare("SELECT id FROM opportunities WHERE id = ?")
    .get(decision.subjectId);
  if (opportunity === undefined) {
    throw new Error("Decision subject opportunity no longer exists.");
  }

  const id = deterministicId(
    "chatgpt",
    decision.decisionType,
    decision.subjectId,
    decision.inputHash,
  );
  const decisionJson = canonicalJson(decision);

  const existing = database
    .prepare(
      `
        SELECT decision_json
        FROM chatgpt_decisions
        WHERE id = ?
      `,
    )
    .get(id) as { decision_json: string } | undefined;

  if (existing !== undefined) {
    if (existing.decision_json !== decisionJson) {
      throw new Error("Conflicting ChatGPT decision replay.");
    }
    return id;
  }

  database
    .prepare(
      `
        INSERT INTO chatgpt_decisions (
          id,
          decision_type,
          subject_id,
          schema_version,
          input_hash,
          decision_json,
          approved_by_owner,
          imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `,
    )
    .run(
      id,
      decision.decisionType,
      decision.subjectId,
      decision.schemaVersion,
      decision.inputHash,
      decisionJson,
      importedAt,
    );

  return id;
}
