import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
} from "../core/deterministic.ts";
import { createReservation } from "./reservations.ts";
import {
  transitionOrder,
  type OrderState,
} from "./state-machine.ts";

interface OrderRow {
  readonly state: OrderState;
  readonly version: bigint;
}

function readOrder(
  database: DatabaseSync,
  orderId: string,
): OrderRow {
  const row = database
    .prepare("SELECT state, version FROM orders WHERE id = ?")
    .get(orderId) as OrderRow | undefined;

  if (row === undefined) {
    throw new Error("Order not found.");
  }
  return row;
}

export interface OrderAuthorizationInput {
  readonly orderId: string;
  readonly sourceOfferId: string;
  readonly authorizedAt: string;
}

type FailureState =
  | "IDENTITY_CONFLICT"
  | "PRICE_BREACH"
  | "SLA_BREACH";

interface AuthorityEvidence {
  readonly item_id: string;
  readonly quantity: bigint;
  readonly accepted_price_paise: bigint;
  readonly trade_unit_id: string;
  readonly listing_source_offer_id: string;
  readonly opportunity_source_offer_id: string;
  readonly decision_state: string;
  readonly approved_price_paise: bigint | null;
  readonly required_cash_paise_per_unit: bigint | null;
  readonly source_fresh_until: string | null;
  readonly pool_latest_offer_id: string | null;
  readonly source_product_id: string;
  readonly trade_product_id: string;
  readonly mapping_status: string;
  readonly trade_mapping_status: string;
  readonly identity_class: string;
  readonly physical_verified_at: string | null;
  readonly supplier_status: string;
  readonly route_active: bigint;
  readonly dispatch_verified: bigint;
  readonly return_verified: bigint;
  readonly package_weight: bigint | null;
  readonly remote_order_status: string | null;
  readonly open_exception_count: bigint;
}

function readAuthorityEvidence(
  database: DatabaseSync,
  orderId: string,
): AuthorityEvidence {
  const rows = database
    .prepare(
      `
        SELECT
          i.id AS item_id,
          i.quantity,
          i.accepted_price_paise,
          i.trade_unit_id,
          l.source_offer_id AS listing_source_offer_id,
          o.source_offer_id AS opportunity_source_offer_id,
          o.decision_state,
          o.approved_price_paise,
          o.required_cash_paise_per_unit,
          o.source_fresh_until,
          p.latest_offer_id AS pool_latest_offer_id,
          s.product_id AS source_product_id,
          t.product_id AS trade_product_id,
          m.mapping_status,
          t.mapping_status AS trade_mapping_status,
          m.identity_class,
          t.physical_verified_at,
          supplier.status AS supplier_status,
          route.active AS route_active,
          route.single_unit_dispatch_verified AS dispatch_verified,
          route.return_route_verified AS return_verified,
          s.packed_weight_grams AS package_weight,
          remote.status AS remote_order_status,
          (
            SELECT COUNT(*)
            FROM exceptions e
            WHERE e.order_id = ord.id
              AND e.state = 'OPEN'
          ) AS open_exception_count
        FROM orders ord
        JOIN order_items i
          ON i.order_id = ord.id
        JOIN listings l
          ON l.id = i.listing_id
        JOIN opportunities o
          ON o.id = l.opportunity_id
        JOIN marketplace_catalogue_items m
          ON m.id = l.marketplace_catalogue_item_id
        JOIN packaged_trade_units t
          ON t.id = m.trade_unit_id
        JOIN source_offers s
          ON s.id = l.source_offer_id
        JOIN source_offer_supply_pools spl
          ON spl.offer_id = s.id
        JOIN supply_pools p
          ON p.id = spl.pool_id
        JOIN suppliers supplier
          ON supplier.id = s.supplier_id
        JOIN fulfilment_routes route
          ON route.id = s.fulfilment_route_id
        LEFT JOIN simulated_marketplace_orders remote
          ON remote.marketplace = ord.marketplace
          AND remote.marketplace_order_id =
            ord.marketplace_order_id
        WHERE ord.id = ?
      `,
    )
    .all(orderId) as unknown as AuthorityEvidence[];

  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(
      "V1 authorization requires one fully bound order item.",
    );
  }
  return rows[0];
}

function failureFromEvidence(
  evidence: AuthorityEvidence,
  sourceOfferId: string,
  authorizedAt: string,
): FailureState | null {
  const authorizedMs = assertCanonicalUtcTimestamp(
    authorizedAt,
    "authorizedAt",
  );

  if (
    evidence.mapping_status !== "APPROVED" ||
    evidence.trade_mapping_status !== "APPROVED" ||
    !["A", "B"].includes(evidence.identity_class) ||
    evidence.physical_verified_at === null ||
    evidence.source_product_id !== evidence.trade_product_id ||
    evidence.trade_unit_id.length === 0
  ) {
    return "IDENTITY_CONFLICT";
  }

  if (
    evidence.decision_state !== "LIST" ||
    evidence.listing_source_offer_id !== sourceOfferId ||
    evidence.opportunity_source_offer_id !== sourceOfferId ||
    evidence.pool_latest_offer_id !== sourceOfferId ||
    evidence.approved_price_paise === null ||
    evidence.approved_price_paise !==
      evidence.accepted_price_paise ||
    evidence.source_fresh_until === null ||
    authorizedMs >=
      new Date(evidence.source_fresh_until).getTime()
  ) {
    return "PRICE_BREACH";
  }

  if (
    evidence.supplier_status !== "verified" ||
    evidence.route_active !== 1n ||
    evidence.dispatch_verified !== 1n ||
    evidence.return_verified !== 1n ||
    evidence.package_weight === null ||
    evidence.remote_order_status !== "ACCEPTED" ||
    evidence.open_exception_count !== 0n
  ) {
    return "SLA_BREACH";
  }

  if (
    evidence.required_cash_paise_per_unit === null ||
    evidence.required_cash_paise_per_unit <= 0n
  ) {
    return "PRICE_BREACH";
  }

  return null;
}

export function validateAndAuthorizeOrder(
  database: DatabaseSync,
  input: OrderAuthorizationInput,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const order = readOrder(database, input.orderId);
    if (order.state !== "RECEIVED") {
      throw new Error("Authorization requires RECEIVED order.");
    }

    let version = transitionOrder(
      database,
      input.orderId,
      "RECEIVED",
      Number(order.version),
      "HELD",
      input.authorizedAt,
    );

    const evidence = readAuthorityEvidence(
      database,
      input.orderId,
    );
    const failure = failureFromEvidence(
      evidence,
      input.sourceOfferId,
      input.authorizedAt,
    );

    if (failure !== null) {
      transitionOrder(
        database,
        input.orderId,
        "HELD",
        version,
        failure,
        input.authorizedAt,
      );
      database.exec("COMMIT");
      return;
    }

    const requiredCash =
      evidence.required_cash_paise_per_unit! *
      evidence.quantity;

    if (requiredCash > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Required order cash exceeds safe integer range.");
    }

    createReservation(database, {
      orderId: input.orderId,
      sourceOfferId: input.sourceOfferId,
      cashPaise: Number(requiredCash),
      createdAt: input.authorizedAt,
    });

    version = transitionOrder(
      database,
      input.orderId,
      "HELD",
      version,
      "RESERVED",
      input.authorizedAt,
    );

    version = transitionOrder(
      database,
      input.orderId,
      "RESERVED",
      version,
      "VALIDATING",
      input.authorizedAt,
    );

    transitionOrder(
      database,
      input.orderId,
      "VALIDATING",
      version,
      "AUTHORIZED",
      input.authorizedAt,
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
