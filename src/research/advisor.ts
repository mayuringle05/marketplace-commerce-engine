import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";

export interface CommerceAdvisorExportRequest {
  readonly schemaVersion: 1;
  readonly productKeys: readonly string[];
}

export interface CommerceAdvisorFact {
  readonly productKey: string;
  readonly evaluationId: string;
  readonly inputHash: string;
  readonly title: string;
  readonly category: string;
  readonly marketplace: string;
  readonly recommendation: string;
  readonly blockingReasons: readonly string[];
  readonly demandClass: string | null;
  readonly demandScore: number;
  readonly competitionScore: number;
  readonly trendConfidence: number;
  readonly marketReferencePricePaise: number;
  readonly supplierCostPaise: number;
  readonly suggestedPricePaise: number | null;
  readonly verifiedPricePaise: number | null;
  readonly netProfitVerified: boolean;
  readonly expectedNetProfitPaise: number | null;
  readonly decisionMarginBps: number | null;
  readonly cashRoiBps: number | null;
  readonly stressNetProfitPaise: number | null;
  readonly stockDecision: string | null;
  readonly recommendedStockUnits: number;
  readonly stockCapitalPaise: number;
  readonly projectedBatchProfitPaise: number | null;
  readonly reorderPointUnits: number;
  readonly sources: readonly {
    readonly kind: string;
    readonly url: string;
  }[];
  readonly transactionAuthority: false;
  readonly supplierContactAuthority: false;
}

export interface CommerceAdvisorPacket {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly facts: readonly CommerceAdvisorFact[];
  readonly transactionAuthority: false;
  readonly supplierContactAuthority: false;
}

export interface SupplierNegotiationAdvice {
  readonly shouldNegotiate: boolean;
  readonly objective: string;
  readonly openingMessage: string | null;
  readonly followUps: readonly string[];
  readonly asks: readonly string[];
  readonly cautions: readonly string[];
}

export interface CommerceAdviceRow {
  readonly productKey: string;
  readonly evaluationId: string;
  readonly inputHash: string;
  readonly headline: string;
  readonly explanation: string;
  readonly recommendedStrategy: readonly string[];
  readonly supplierNegotiation: SupplierNegotiationAdvice;
}

export interface CommerceAdvicePack {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly advice: readonly CommerceAdviceRow[];
  readonly transactionAuthority: false;
  readonly supplierContactAuthority: false;
}

interface AdvisorDbRow {
  readonly product_key: string;
  readonly evaluation_id: string;
  readonly generic_title: string;
  readonly category: string;
  readonly marketplace: string;
  readonly recommendation: string;
  readonly blocking_reasons_json: string;
  readonly demand_class: string | null;
  readonly demand_score: bigint;
  readonly competition_score: bigint;
  readonly trend_confidence: bigint;
  readonly market_reference_price_paise: bigint;
  readonly supplier_cost_paise: bigint;
  readonly suggested_price_paise: bigint | null;
  readonly verified_price_paise: bigint | null;
  readonly net_profit_verified: bigint;
  readonly expected_net_profit_paise: bigint | null;
  readonly decision_margin_bps: bigint | null;
  readonly cash_roi_bps: bigint | null;
  readonly stress_net_profit_paise: bigint | null;
  readonly stock_decision: string | null;
  readonly recommended_stock_units: bigint | null;
  readonly stock_capital_paise: bigint | null;
  readonly projected_batch_profit_paise: bigint | null;
  readonly reorder_point_units: bigint | null;
  readonly sources_json: string;
}

function asNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
}

function requireText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(
      `${label} must be a non-empty string up to ${maximumLength} characters.`,
    );
  }
  return value.trim();
}

function requireStringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  itemMaximumLength: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new Error(
      `${label} must contain ${minimum}..${maximum} entries.`,
    );
  }
  return value.map((item, index) =>
    requireText(
      item,
      `${label}[${index}]`,
      itemMaximumLength,
    ),
  );
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} does not match the exact schema.`);
  }
  return record;
}

export function parseCommerceAdvisorExportRequest(
  json: string,
): CommerceAdvisorExportRequest {
  const value = exactObject(
    JSON.parse(json) as unknown,
    ["schemaVersion", "productKeys"],
    "advisor export request",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("advisor export request schemaVersion must be 1.");
  }
  if (
    !Array.isArray(value.productKeys) ||
    value.productKeys.length < 1 ||
    value.productKeys.length > 50
  ) {
    throw new Error("productKeys must contain 1..50 entries.");
  }
  const productKeys = value.productKeys.map((item, index) =>
    requireText(item, `productKeys[${index}]`, 160),
  );
  if (new Set(productKeys).size !== productKeys.length) {
    throw new Error("productKeys must be unique.");
  }
  return {
    schemaVersion: 1,
    productKeys,
  };
}

export function buildCommerceAdvisorPacket(
  database: DatabaseSync,
  request: CommerceAdvisorExportRequest,
  generatedAt: string,
): CommerceAdvisorPacket {
  assertCanonicalUtcTimestamp(generatedAt, "generatedAt");

  const getLatest = database.prepare(
    `
      SELECT
        r.product_key,
        e.id AS evaluation_id,
        r.generic_title,
        r.category,
        e.marketplace,
        e.recommendation,
        e.blocking_reasons_json,
        e.demand_class,
        e.demand_score,
        e.competition_score,
        e.trend_confidence,
        e.market_reference_price_paise,
        e.supplier_cost_paise,
        e.suggested_price_paise,
        e.verified_price_paise,
        e.net_profit_verified,
        e.expected_net_profit_paise,
        e.decision_margin_bps,
        e.cash_roi_bps,
        e.stress_net_profit_paise,
        e.stock_decision,
        e.recommended_stock_units,
        e.stock_capital_paise,
        e.projected_batch_profit_paise,
        e.reorder_point_units,
        e.sources_json
      FROM research_subjects r
      JOIN research_evaluations e
        ON e.product_key = r.product_key
      WHERE r.product_key = ?
      ORDER BY e.created_at DESC, e.generated_at DESC
      LIMIT 1
    `,
  );

  const facts = request.productKeys.map((productKey) => {
    const row = getLatest.get(productKey) as unknown as
      | AdvisorDbRow
      | undefined;
    if (row === undefined) {
      throw new Error(
        `No research evaluation exists for productKey ${productKey}.`,
      );
    }

    const factBase = {
      productKey: row.product_key,
      evaluationId: row.evaluation_id,
      title: row.generic_title,
      category: row.category,
      marketplace: row.marketplace,
      recommendation: row.recommendation,
      blockingReasons: parseJson<readonly string[]>(
        row.blocking_reasons_json,
        "blocking_reasons_json",
      ),
      demandClass: row.demand_class,
      demandScore: Number(row.demand_score),
      competitionScore: Number(row.competition_score),
      trendConfidence: Number(row.trend_confidence),
      marketReferencePricePaise: Number(
        row.market_reference_price_paise,
      ),
      supplierCostPaise: Number(row.supplier_cost_paise),
      suggestedPricePaise: asNumber(row.suggested_price_paise),
      verifiedPricePaise: asNumber(row.verified_price_paise),
      netProfitVerified: Number(row.net_profit_verified) === 1,
      expectedNetProfitPaise: asNumber(
        row.expected_net_profit_paise,
      ),
      decisionMarginBps: asNumber(row.decision_margin_bps),
      cashRoiBps: asNumber(row.cash_roi_bps),
      stressNetProfitPaise: asNumber(
        row.stress_net_profit_paise,
      ),
      stockDecision: row.stock_decision,
      recommendedStockUnits:
        asNumber(row.recommended_stock_units) ?? 0,
      stockCapitalPaise:
        asNumber(row.stock_capital_paise) ?? 0,
      projectedBatchProfitPaise: asNumber(
        row.projected_batch_profit_paise,
      ),
      reorderPointUnits:
        asNumber(row.reorder_point_units) ?? 0,
      sources: parseJson<
        readonly { readonly kind: string; readonly url: string }[]
      >(row.sources_json, "sources_json"),
      transactionAuthority: false as const,
      supplierContactAuthority: false as const,
    };
    const inputHash = sha256Hex(canonicalJson(factBase));
    return {
      productKey: factBase.productKey,
      evaluationId: factBase.evaluationId,
      inputHash,
      title: factBase.title,
      category: factBase.category,
      marketplace: factBase.marketplace,
      recommendation: factBase.recommendation,
      blockingReasons: factBase.blockingReasons,
      demandClass: factBase.demandClass,
      demandScore: factBase.demandScore,
      competitionScore: factBase.competitionScore,
      trendConfidence: factBase.trendConfidence,
      marketReferencePricePaise:
        factBase.marketReferencePricePaise,
      supplierCostPaise: factBase.supplierCostPaise,
      suggestedPricePaise: factBase.suggestedPricePaise,
      verifiedPricePaise: factBase.verifiedPricePaise,
      netProfitVerified: factBase.netProfitVerified,
      expectedNetProfitPaise:
        factBase.expectedNetProfitPaise,
      decisionMarginBps: factBase.decisionMarginBps,
      cashRoiBps: factBase.cashRoiBps,
      stressNetProfitPaise: factBase.stressNetProfitPaise,
      stockDecision: factBase.stockDecision,
      recommendedStockUnits:
        factBase.recommendedStockUnits,
      stockCapitalPaise: factBase.stockCapitalPaise,
      projectedBatchProfitPaise:
        factBase.projectedBatchProfitPaise,
      reorderPointUnits: factBase.reorderPointUnits,
      sources: factBase.sources,
      transactionAuthority: false as const,
      supplierContactAuthority: false as const,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    facts,
    transactionAuthority: false,
    supplierContactAuthority: false,
  };
}

export function validateCommerceAdvicePack(
  value: unknown,
  packet: CommerceAdvisorPacket,
): CommerceAdvicePack {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "generatedAt",
      "advice",
      "transactionAuthority",
      "supplierContactAuthority",
    ],
    "commerce advice pack",
  );
  if (
    root.schemaVersion !== 1 ||
    root.transactionAuthority !== false ||
    root.supplierContactAuthority !== false
  ) {
    throw new Error("commerce advice pack safety contract is invalid.");
  }
  const generatedAt = requireText(
    root.generatedAt,
    "generatedAt",
    64,
  );
  assertCanonicalUtcTimestamp(generatedAt, "generatedAt");

  if (
    !Array.isArray(root.advice) ||
    root.advice.length !== packet.facts.length
  ) {
    throw new Error(
      "commerce advice must contain exactly one row per advisor fact.",
    );
  }

  const expected = new Map(
    packet.facts.map((fact) => [
      fact.productKey,
      fact,
    ]),
  );

  const advice = root.advice.map((item, index) => {
    const row = exactObject(
      item,
      [
        "productKey",
        "evaluationId",
        "inputHash",
        "headline",
        "explanation",
        "recommendedStrategy",
        "supplierNegotiation",
      ],
      `advice[${index}]`,
    );
    const productKey = requireText(
      row.productKey,
      `advice[${index}].productKey`,
      160,
    );
    const fact = expected.get(productKey);
    if (fact === undefined) {
      throw new Error("commerce advice returned an unknown productKey.");
    }
    if (
      row.evaluationId !== fact.evaluationId ||
      row.inputHash !== fact.inputHash
    ) {
      throw new Error(
        "commerce advice is not bound to the deterministic input.",
      );
    }
    expected.delete(productKey);

    const negotiation = exactObject(
      row.supplierNegotiation,
      [
        "shouldNegotiate",
        "objective",
        "openingMessage",
        "followUps",
        "asks",
        "cautions",
      ],
      `advice[${index}].supplierNegotiation`,
    );
    if (typeof negotiation.shouldNegotiate !== "boolean") {
      throw new Error(
        `advice[${index}].supplierNegotiation.shouldNegotiate must be boolean.`,
      );
    }
    const openingMessage =
      negotiation.openingMessage === null
        ? null
        : requireText(
            negotiation.openingMessage,
            `advice[${index}].supplierNegotiation.openingMessage`,
            2_000,
          );

    if (
      negotiation.shouldNegotiate === false &&
      openingMessage !== null
    ) {
      throw new Error(
        "openingMessage must be null when shouldNegotiate is false.",
      );
    }

    return {
      productKey,
      evaluationId: fact.evaluationId,
      inputHash: fact.inputHash,
      headline: requireText(
        row.headline,
        `advice[${index}].headline`,
        180,
      ),
      explanation: requireText(
        row.explanation,
        `advice[${index}].explanation`,
        2_500,
      ),
      recommendedStrategy: requireStringArray(
        row.recommendedStrategy,
        `advice[${index}].recommendedStrategy`,
        1,
        6,
        500,
      ),
      supplierNegotiation: {
        shouldNegotiate: negotiation.shouldNegotiate,
        objective: requireText(
          negotiation.objective,
          `advice[${index}].supplierNegotiation.objective`,
          700,
        ),
        openingMessage,
        followUps: requireStringArray(
          negotiation.followUps,
          `advice[${index}].supplierNegotiation.followUps`,
          0,
          6,
          500,
        ),
        asks: requireStringArray(
          negotiation.asks,
          `advice[${index}].supplierNegotiation.asks`,
          negotiation.shouldNegotiate ? 1 : 0,
          8,
          400,
        ),
        cautions: requireStringArray(
          negotiation.cautions,
          `advice[${index}].supplierNegotiation.cautions`,
          1,
          8,
          500,
        ),
      },
    };
  });

  if (expected.size !== 0) {
    throw new Error("commerce advice omitted one or more product keys.");
  }

  return {
    schemaVersion: 1,
    generatedAt,
    advice,
    transactionAuthority: false,
    supplierContactAuthority: false,
  };
}

export function persistCommerceAdvice(
  database: DatabaseSync,
  pack: CommerceAdvicePack,
): number {
  const insert = database.prepare(
    `
      INSERT INTO research_advice (
        id,
        research_evaluation_id,
        product_key,
        input_hash,
        model_source,
        headline,
        explanation,
        recommended_strategy_json,
        supplier_negotiation_json,
        transaction_authority,
        supplier_contact_authority,
        created_at
      ) VALUES (?, ?, ?, ?, 'CHATGPT_COSMO', ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(research_evaluation_id, input_hash)
      DO UPDATE SET
        headline = excluded.headline,
        explanation = excluded.explanation,
        recommended_strategy_json =
          excluded.recommended_strategy_json,
        supplier_negotiation_json =
          excluded.supplier_negotiation_json,
        created_at = excluded.created_at
    `,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of pack.advice) {
      insert.run(
        deterministicId(
          "research_advice",
          row.evaluationId,
          row.inputHash,
        ),
        row.evaluationId,
        row.productKey,
        row.inputHash,
        row.headline,
        row.explanation,
        canonicalJson(row.recommendedStrategy),
        canonicalJson(row.supplierNegotiation),
        pack.generatedAt,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return pack.advice.length;
}
