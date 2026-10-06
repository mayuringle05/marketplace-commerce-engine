import { readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
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
  path: string,
  packet: ResearchPacket,
): string {
  const json = canonicalJson(packet);
  writeFileSync(path, `${json}\n`, "utf8");
  return sha256Hex(json);
}

export function parseChatGptDecisionJson(
  json: string,
): ChatGptDecision {
  const value = JSON.parse(json) as unknown;

  if (typeof value !== "object" || value === null) {
    throw new Error("Decision must be an object.");
  }

  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.decisionType !== "RESEARCH_RECOMMENDATION" ||
    typeof record.subjectId !== "string" ||
    typeof record.inputHash !== "string" ||
    !["INVESTIGATE", "HOLD", "IGNORE"].includes(
      String(record.recommendation),
    ) ||
    typeof record.rationale !== "string"
  ) {
    throw new Error("Decision does not match schema version 1.");
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
  const decision = parseChatGptDecisionJson(
    readFileSync(path, "utf8"),
  );

  const id = deterministicId(
    "chatgpt",
    decision.decisionType,
    decision.subjectId,
    decision.inputHash,
  );

  database
    .prepare(
      `
        INSERT OR IGNORE INTO chatgpt_decisions (
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
      canonicalJson(decision),
      importedAt,
    );

  return id;
}
