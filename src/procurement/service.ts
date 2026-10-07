import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";
import { appendAuditEvent } from "../core/audit.ts";
import {
  acquireAccountLock,
  assertCurrentAccountLock,
  releaseAccountLock,
  type AccountLock,
} from "../runtime/account-lock.ts";
import {
  transitionOrder,
  type OrderState,
} from "../orders/state-machine.ts";
import {
  releaseReservation,
} from "../orders/reservations.ts";
import {
  consumeStockCommitments,
} from "../supplier/pools.ts";
import type {
  SupplierPurchaseAdapter,
  SupplierPurchaseRequest,
  SupplierPurchaseResult,
} from "../supplier/simulated-purchase.ts";

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

export interface PurchaseIntentInput {
  readonly orderId: string;
  readonly destinationKey: string;
  readonly authorizationExpiresAt: string;
  readonly createdAt: string;
}

interface IntentEvidence {
  readonly order_item_id: string;
  readonly quantity: bigint;
  readonly trade_unit_id: string;
  readonly reservation_id: string;
  readonly reservation_units: bigint;
  readonly reservation_cash_paise: bigint;
  readonly reservation_status: string;
  readonly source_offer_id: string;
  readonly supply_pool_id: string;
  readonly supplier_id: string;
  readonly supplier_sku: string;
  readonly gross_cost_paise: bigint;
  readonly fulfilment_route_id: string;
  readonly latest_offer_id: string | null;
  readonly mapping_version: bigint;
  readonly mapping_status: string;
  readonly trade_mapping_status: string;
  readonly physical_verified_at: string | null;
  readonly stock_state: string;
  readonly remote_status: string | null;
  readonly open_exception_count: bigint;
}

function readIntentEvidence(
  database: DatabaseSync,
  orderId: string,
): IntentEvidence {
  const rows = database
    .prepare(
      `
        SELECT
          i.id AS order_item_id,
          i.quantity,
          i.trade_unit_id,
          r.id AS reservation_id,
          r.units AS reservation_units,
          r.cash_paise AS reservation_cash_paise,
          r.status AS reservation_status,
          r.source_offer_id,
          r.supply_pool_id,
          s.supplier_id,
          s.supplier_sku,
          s.gross_cost_paise,
          s.fulfilment_route_id,
          p.latest_offer_id,
          m.mapping_version,
          m.mapping_status,
          t.mapping_status AS trade_mapping_status,
          t.physical_verified_at,
          c.state AS stock_state,
          remote.status AS remote_status,
          (
            SELECT COUNT(*)
            FROM exceptions e
            WHERE e.order_id = o.id
              AND e.state = 'OPEN'
          ) AS open_exception_count
        FROM orders o
        JOIN order_items i
          ON i.order_id = o.id
        JOIN listings l
          ON l.id = i.listing_id
        JOIN marketplace_catalogue_items m
          ON m.id = l.marketplace_catalogue_item_id
        JOIN packaged_trade_units t
          ON t.id = i.trade_unit_id
        JOIN reservations r
          ON r.order_id = o.id
        JOIN source_offers s
          ON s.id = r.source_offer_id
        JOIN supply_pools p
          ON p.id = r.supply_pool_id
        JOIN stock_commitments c
          ON c.order_item_id = i.id
        LEFT JOIN simulated_marketplace_orders remote
          ON remote.marketplace = o.marketplace
          AND remote.marketplace_order_id =
            o.marketplace_order_id
        WHERE o.id = ?
      `,
    )
    .all(orderId) as unknown as IntentEvidence[];

  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(
      "V1 purchase intent requires one fully bound order item and reservation.",
    );
  }
  return rows[0];
}

export function recordPurchaseIntent(
  database: DatabaseSync,
  input: PurchaseIntentInput,
): string {
  if (input.destinationKey.trim().length === 0) {
    throw new Error("Purchase destination key is required.");
  }

  const createdMs = assertCanonicalUtcTimestamp(
    input.createdAt,
    "createdAt",
  );
  const expiresMs = assertCanonicalUtcTimestamp(
    input.authorizationExpiresAt,
    "authorizationExpiresAt",
  );
  if (
    expiresMs <= createdMs ||
    expiresMs - createdMs > 5 * 60 * 1_000
  ) {
    throw new Error(
      "Purchase authorization must expire within five minutes after creation.",
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const order = readOrder(database, input.orderId);
    if (order.state !== "AUTHORIZED") {
      throw new Error(
        "Purchase intent requires AUTHORIZED order.",
      );
    }

    const evidence = readIntentEvidence(
      database,
      input.orderId,
    );

    if (
      evidence.reservation_status !== "ACTIVE" ||
      evidence.reservation_units !== evidence.quantity ||
      evidence.stock_state !== "RESERVED" ||
      evidence.latest_offer_id !== evidence.source_offer_id ||
      evidence.mapping_status !== "APPROVED" ||
      evidence.trade_mapping_status !== "APPROVED" ||
      evidence.physical_verified_at === null ||
      evidence.remote_status !== "ACCEPTED" ||
      evidence.open_exception_count !== 0n
    ) {
      throw new Error(
        "Purchase authority evidence is incomplete, stale, or invalidated.",
      );
    }

    const exactAmount =
      evidence.gross_cost_paise * evidence.quantity;
    if (
      exactAmount > evidence.reservation_cash_paise ||
      exactAmount > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        "Authorized supplier spend exceeds the order cash reservation.",
      );
    }

    const payload = {
      orderId: input.orderId,
      reservationId: evidence.reservation_id,
      orderItemId: evidence.order_item_id,
      supplierId: evidence.supplier_id,
      supplierSku: evidence.supplier_sku,
      supplyPoolId: evidence.supply_pool_id,
      sourceOfferId: evidence.source_offer_id,
      fulfilmentRouteId: evidence.fulfilment_route_id,
      tradeUnitId: evidence.trade_unit_id,
      mappingVersion: Number(evidence.mapping_version),
      destinationKey: input.destinationKey,
      quantity: Number(evidence.quantity),
      maximumAmountPaise: Number(exactAmount),
      expiresAt: input.authorizationExpiresAt,
    };
    const payloadHash = sha256Hex(canonicalJson(payload));
    const authorizationId = deterministicId(
      "purchaseauth",
      input.orderId,
      payloadHash,
    );
    const poId = deterministicId("po", input.orderId);
    const clientPoRef = `COSMO-${input.orderId.slice(-12)}`;
    const idempotencyKey = deterministicId(
      "idem",
      evidence.supplier_id,
      clientPoRef,
      payloadHash,
    );
    const intentId = deterministicId(
      "intent",
      "PURCHASE",
      input.orderId,
      payloadHash,
    );

    database
      .prepare(
        `
          INSERT INTO purchase_authorizations (
            id,
            order_id,
            reservation_id,
            order_item_id,
            supplier_id,
            supplier_sku,
            supply_pool_id,
            source_offer_id,
            fulfilment_route_id,
            trade_unit_id,
            mapping_version,
            destination_key,
            quantity,
            maximum_amount_paise,
            payload_hash,
            expires_at,
            consumed_at,
            created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
          )
        `,
      )
      .run(
        authorizationId,
        input.orderId,
        evidence.reservation_id,
        evidence.order_item_id,
        evidence.supplier_id,
        evidence.supplier_sku,
        evidence.supply_pool_id,
        evidence.source_offer_id,
        evidence.fulfilment_route_id,
        evidence.trade_unit_id,
        evidence.mapping_version,
        input.destinationKey,
        evidence.quantity,
        exactAmount,
        payloadHash,
        input.authorizationExpiresAt,
        input.createdAt,
      );

    database
      .prepare(
        `
          INSERT INTO purchase_orders (
            id,
            order_id,
            supplier_id,
            client_po_ref,
            provider_po_id,
            state,
            authorized_amount_paise,
            quantity,
            payload_hash,
            idempotency_key,
            version,
            created_at,
            updated_at,
            authorization_expires_at,
            authorization_id
          ) VALUES (
            ?, ?, ?, ?, NULL, 'INTENT_RECORDED',
            ?, ?, ?, ?, 1, ?, ?, ?, ?
          )
        `,
      )
      .run(
        poId,
        input.orderId,
        evidence.supplier_id,
        clientPoRef,
        exactAmount,
        evidence.quantity,
        payloadHash,
        idempotencyKey,
        input.createdAt,
        input.createdAt,
        input.authorizationExpiresAt,
        authorizationId,
      );

    database
      .prepare(
        `
          INSERT INTO action_intents (
            id,
            action_type,
            account_scope,
            subject_id,
            payload_hash,
            state,
            fencing_token,
            provider_ref,
            created_at,
            updated_at
          ) VALUES (?, 'PURCHASE', ?, ?, ?, 'RECORDED', 0, NULL, ?, ?)
        `,
      )
      .run(
        intentId,
        evidence.supplier_id,
        input.orderId,
        payloadHash,
        input.createdAt,
        input.createdAt,
      );

    transitionOrder(
      database,
      input.orderId,
      "AUTHORIZED",
      Number(order.version),
      "PO_INTENT_RECORDED",
      input.createdAt,
    );

    database.exec("COMMIT");
    return poId;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

interface ExecutionRow {
  readonly order_id: string;
  readonly order_state: OrderState;
  readonly order_version: bigint;
  readonly supplier_id: string;
  readonly client_po_ref: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly po_state: string;
  readonly authorization_id: string;
  readonly authorization_expires_at: string;
  readonly supplier_sku: string;
  readonly source_offer_id: string;
  readonly supply_pool_id: string;
  readonly fulfilment_route_id: string;
  readonly trade_unit_id: string;
  readonly mapping_version: bigint;
  readonly destination_key: string;
  readonly quantity: bigint;
  readonly maximum_amount_paise: bigint;
  readonly consumed_at: string | null;
  readonly remote_status: string | null;
  readonly latest_offer_id: string | null;
  readonly mapping_status: string;
  readonly trade_mapping_status: string;
  readonly physical_verified_at: string | null;
  readonly supplier_status: string;
  readonly route_active: bigint;
  readonly open_exception_count: bigint;
}

function readExecutionRow(
  database: DatabaseSync,
  poId: string,
): ExecutionRow {
  const row = database
    .prepare(
      `
        SELECT
          po.order_id,
          o.state AS order_state,
          o.version AS order_version,
          po.supplier_id,
          po.client_po_ref,
          po.idempotency_key,
          po.payload_hash,
          po.state AS po_state,
          po.authorization_id,
          a.expires_at AS authorization_expires_at,
          a.supplier_sku,
          a.source_offer_id,
          a.supply_pool_id,
          a.fulfilment_route_id,
          a.trade_unit_id,
          a.mapping_version,
          a.destination_key,
          a.quantity,
          a.maximum_amount_paise,
          a.consumed_at,
          remote.status AS remote_status,
          pool.latest_offer_id,
          m.mapping_status,
          t.mapping_status AS trade_mapping_status,
          t.physical_verified_at,
          supplier.status AS supplier_status,
          route.active AS route_active,
          (
            SELECT COUNT(*)
            FROM exceptions e
            WHERE e.order_id = o.id
              AND e.state = 'OPEN'
          ) AS open_exception_count
        FROM purchase_orders po
        JOIN purchase_authorizations a
          ON a.id = po.authorization_id
        JOIN orders o
          ON o.id = po.order_id
        JOIN order_items i
          ON i.id = a.order_item_id
        JOIN listings l
          ON l.id = i.listing_id
        JOIN marketplace_catalogue_items m
          ON m.id = l.marketplace_catalogue_item_id
        JOIN packaged_trade_units t
          ON t.id = a.trade_unit_id
        JOIN supply_pools pool
          ON pool.id = a.supply_pool_id
        JOIN suppliers supplier
          ON supplier.id = a.supplier_id
        JOIN fulfilment_routes route
          ON route.id = a.fulfilment_route_id
        LEFT JOIN simulated_marketplace_orders remote
          ON remote.marketplace = o.marketplace
          AND remote.marketplace_order_id =
            o.marketplace_order_id
        WHERE po.id = ?
      `,
    )
    .get(poId) as ExecutionRow | undefined;

  if (row === undefined) {
    throw new Error("Purchase execution authority not found.");
  }
  return row;
}

function requestFromExecution(
  row: ExecutionRow,
  submittedAt: string,
): SupplierPurchaseRequest {
  if (
    row.maximum_amount_paise > BigInt(Number.MAX_SAFE_INTEGER) ||
    row.quantity > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Authorized purchase exceeds safe integer range.");
  }

  return {
    idempotencyKey: row.idempotency_key,
    clientPoRef: row.client_po_ref,
    supplierId: row.supplier_id,
    supplierSku: row.supplier_sku,
    amountPaise: Number(row.maximum_amount_paise),
    quantity: Number(row.quantity),
    destinationKey: row.destination_key,
    submittedAt,
  };
}

function assertExecutionStillValid(
  row: ExecutionRow,
  submittedAt: string,
): void {
  const submittedMs = assertCanonicalUtcTimestamp(
    submittedAt,
    "submittedAt",
  );
  const expiresMs = assertCanonicalUtcTimestamp(
    row.authorization_expires_at,
    "authorizationExpiresAt",
  );

  if (submittedMs >= expiresMs) {
    throw new Error("Purchase authorization has expired.");
  }

  if (
    row.remote_status !== "ACCEPTED" ||
    row.latest_offer_id !== row.source_offer_id ||
    row.mapping_status !== "APPROVED" ||
    row.trade_mapping_status !== "APPROVED" ||
    row.physical_verified_at === null ||
    row.supplier_status !== "verified" ||
    row.route_active !== 1n ||
    row.open_exception_count !== 0n
  ) {
    throw new Error(
      "Purchase execution evidence is stale, cancelled, invalidated, or unresolved.",
    );
  }
}

function rejectUnspentIntent(
  database: DatabaseSync,
  poId: string,
  nextOrderState: "CUSTOMER_CANCELLED" | "SLA_BREACH",
  reason: string,
  at: string,
): void {
  const row = readExecutionRow(database, poId);
  if (
    row.po_state !== "INTENT_RECORDED" ||
    row.order_state !== "PO_INTENT_RECORDED" ||
    row.consumed_at !== null
  ) {
    throw new Error("Purchase intent is no longer provably unspent.");
  }

  database
    .prepare(
      `
        UPDATE purchase_orders
        SET
          state = 'REJECTED',
          version = version + 1,
          updated_at = ?
        WHERE id = ?
          AND state = 'INTENT_RECORDED'
      `,
    )
    .run(at, poId);

  database
    .prepare(
      `
        UPDATE action_intents
        SET
          state = 'REJECTED',
          updated_at = ?
        WHERE action_type = 'PURCHASE'
          AND subject_id = ?
          AND payload_hash = ?
          AND state = 'RECORDED'
      `,
    )
    .run(at, row.order_id, row.payload_hash);

  transitionOrder(
    database,
    row.order_id,
    "PO_INTENT_RECORDED",
    Number(row.order_version),
    nextOrderState,
    at,
  );
  releaseReservation(database, row.order_id, at);

  appendAuditEvent(database, {
    eventType: "PURCHASE_INTENT_REJECTED_BEFORE_PROVIDER",
    subjectType: "purchase_order",
    subjectId: poId,
    payload: { reason, nextOrderState },
    occurredAt: at,
  });
}

function markPurchaseUnknown(
  database: DatabaseSync,
  poId: string,
  at: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = readExecutionRow(database, poId);

    if (row.po_state === "PURCHASE_UNKNOWN") {
      database.exec("COMMIT");
      return;
    }

    if (row.po_state !== "SUBMITTING") {
      throw new Error(
        "Only SUBMITTING purchase can become PURCHASE_UNKNOWN.",
      );
    }

    database
      .prepare(
        `
          UPDATE purchase_orders
          SET
            state = 'PURCHASE_UNKNOWN',
            version = version + 1,
            updated_at = ?
          WHERE id = ?
            AND state = 'SUBMITTING'
        `,
      )
      .run(at, poId);

    database
      .prepare(
        `
          UPDATE action_intents
          SET
            state = 'UNKNOWN_SIDE_EFFECT',
            updated_at = ?
          WHERE action_type = 'PURCHASE'
            AND subject_id = ?
            AND payload_hash = ?
            AND state = 'SUBMITTING'
        `,
      )
      .run(at, row.order_id, row.payload_hash);

    if (row.order_state === "PO_SUBMITTING") {
      transitionOrder(
        database,
        row.order_id,
        "PO_SUBMITTING",
        Number(row.order_version),
        "PAYMENT_UNKNOWN",
        at,
      );
    }

    const exceptionId = deterministicId(
      "exception",
      row.order_id,
      "PURCHASE_UNKNOWN",
    );
    database
      .prepare(
        `
          INSERT INTO exceptions (
            id,
            order_id,
            exception_type,
            owner,
            deadline_at,
            safe_next_action,
            exposure_reserved,
            state,
            created_at,
            resolved_at
          ) VALUES (
            ?, ?, 'PURCHASE_UNKNOWN', 'OWNER', ?, ?, 1, 'OPEN', ?, NULL
          )
          ON CONFLICT(id) DO NOTHING
        `,
      )
      .run(
        exceptionId,
        row.order_id,
        at,
        "Reconcile provider history using the exact persisted authorization; never resubmit.",
        at,
      );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function finalizeProviderResult(
  database: DatabaseSync,
  poId: string,
  result: SupplierPurchaseResult,
  at: string,
): void {
  if (result.state === "UNKNOWN") {
    markPurchaseUnknown(database, poId, at);
    return;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const row = readExecutionRow(database, poId);
    if (
      row.po_state !== "SUBMITTING" &&
      row.po_state !== "PURCHASE_UNKNOWN"
    ) {
      throw new Error(
        "Purchase result cannot be applied from the current state.",
      );
    }

    const expectedOrderState =
      row.order_state === "PAYMENT_UNKNOWN"
        ? "PAYMENT_UNKNOWN"
        : "PO_SUBMITTING";

    if (result.state === "CONFIRMED") {
      database
        .prepare(
          `
            UPDATE purchase_orders
            SET
              state = 'CONFIRMED',
              provider_po_id = ?,
              version = version + 1,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(result.providerPoId, at, poId);

      database
        .prepare(
          `
            UPDATE action_intents
            SET
              state = 'SUCCEEDED',
              provider_ref = ?,
              updated_at = ?
            WHERE action_type = 'PURCHASE'
              AND subject_id = ?
              AND payload_hash = ?
          `,
        )
        .run(
          result.providerPoId,
          at,
          row.order_id,
          row.payload_hash,
        );

      transitionOrder(
        database,
        row.order_id,
        expectedOrderState,
        Number(row.order_version),
        "PO_CONFIRMED",
        at,
      );

      consumeStockCommitments(
        database,
        row.order_id,
        at,
      );
    } else {
      database
        .prepare(
          `
            UPDATE purchase_orders
            SET
              state = 'REJECTED',
              provider_po_id = ?,
              version = version + 1,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(result.providerPoId, at, poId);

      database
        .prepare(
          `
            UPDATE action_intents
            SET
              state = 'REJECTED',
              provider_ref = ?,
              updated_at = ?
            WHERE action_type = 'PURCHASE'
              AND subject_id = ?
              AND payload_hash = ?
          `,
        )
        .run(
          result.providerPoId,
          at,
          row.order_id,
          row.payload_hash,
        );

      transitionOrder(
        database,
        row.order_id,
        expectedOrderState,
        Number(row.order_version),
        "SUPPLIER_REJECTED",
        at,
      );
      releaseReservation(database, row.order_id, at);
    }

    database
      .prepare(
        `
          UPDATE exceptions
          SET state = 'RESOLVED', resolved_at = ?
          WHERE order_id = ?
            AND exception_type = 'PURCHASE_UNKNOWN'
            AND state = 'OPEN'
        `,
      )
      .run(at, row.order_id);

    appendAuditEvent(database, {
      eventType: "PURCHASE_PROVIDER_RESULT",
      subjectType: "purchase_order",
      subjectId: poId,
      payload: result,
      occurredAt: at,
    });

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function cancelBeforeProviderCall(
  database: DatabaseSync,
  poId: string,
  at: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = readExecutionRow(database, poId);
    if (
      row.po_state !== "SUBMITTING" ||
      row.order_state !== "PO_SUBMITTING"
    ) {
      throw new Error("Purchase is not cancellable before provider call.");
    }

    database
      .prepare(
        `
          UPDATE purchase_orders
          SET
            state = 'REJECTED',
            version = version + 1,
            updated_at = ?
          WHERE id = ?
            AND state = 'SUBMITTING'
        `,
      )
      .run(at, poId);

    database
      .prepare(
        `
          UPDATE action_intents
          SET state = 'REJECTED', updated_at = ?
          WHERE action_type = 'PURCHASE'
            AND subject_id = ?
            AND payload_hash = ?
        `,
      )
      .run(at, row.order_id, row.payload_hash);

    transitionOrder(
      database,
      row.order_id,
      "PO_SUBMITTING",
      Number(row.order_version),
      "CUSTOMER_CANCELLED",
      at,
    );
    releaseReservation(database, row.order_id, at);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function submitPurchaseOnce(
  database: DatabaseSync,
  poId: string,
  adapter: SupplierPurchaseAdapter,
  submittedAt: string,
  owner = "purchase-worker",
): void {
  const initial = readExecutionRow(database, poId);
  if (
    initial.po_state !== "INTENT_RECORDED" ||
    initial.order_state !== "PO_INTENT_RECORDED" ||
    initial.consumed_at !== null
  ) {
    throw new Error(
      "Purchase is not eligible for first submission; reconcile instead.",
    );
  }

  const submittedMs = assertCanonicalUtcTimestamp(
    submittedAt,
    "submittedAt",
  );
  const leaseUntil = new Date(
    submittedMs + 60_000,
  ).toISOString();
  const lock = acquireAccountLock(
    database,
    `supplier:${initial.supplier_id}`,
    owner,
    submittedAt,
    leaseUntil,
  );

  let providerCalled = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = readExecutionRow(database, poId);
      if (
        row.po_state !== "INTENT_RECORDED" ||
        row.order_state !== "PO_INTENT_RECORDED" ||
        row.consumed_at !== null
      ) {
        throw new Error("Purchase authority was already consumed.");
      }

      const submittedMsInside = assertCanonicalUtcTimestamp(
        submittedAt,
        "submittedAt",
      );
      const expiryMsInside = assertCanonicalUtcTimestamp(
        row.authorization_expires_at,
        "authorizationExpiresAt",
      );

      if (submittedMsInside >= expiryMsInside) {
        rejectUnspentIntent(
          database,
          poId,
          "SLA_BREACH",
          "PURCHASE_AUTHORIZATION_EXPIRED",
          submittedAt,
        );
        database.exec("COMMIT");
        return;
      }

      if (row.remote_status !== "ACCEPTED") {
        rejectUnspentIntent(
          database,
          poId,
          "CUSTOMER_CANCELLED",
          "MARKETPLACE_ORDER_NOT_ACCEPTED",
          submittedAt,
        );
        database.exec("COMMIT");
        return;
      }

      assertExecutionStillValid(row, submittedAt);

      transitionOrder(
        database,
        row.order_id,
        "PO_INTENT_RECORDED",
        Number(row.order_version),
        "PO_SUBMITTING",
        submittedAt,
      );

      const poUpdate = database
        .prepare(
          `
            UPDATE purchase_orders
            SET
              state = 'SUBMITTING',
              version = version + 1,
              updated_at = ?
            WHERE id = ?
              AND state = 'INTENT_RECORDED'
          `,
        )
        .run(submittedAt, poId);
      if (poUpdate.changes !== 1n) {
        throw new Error("Purchase submission compare-and-set failed.");
      }

      const authUpdate = database
        .prepare(
          `
            UPDATE purchase_authorizations
            SET consumed_at = ?
            WHERE id = ?
              AND consumed_at IS NULL
          `,
        )
        .run(submittedAt, row.authorization_id);
      if (authUpdate.changes !== 1n) {
        throw new Error("Purchase authorization was already consumed.");
      }

      database
        .prepare(
          `
            UPDATE action_intents
            SET
              state = 'SUBMITTING',
              fencing_token = ?,
              updated_at = ?
            WHERE action_type = 'PURCHASE'
              AND subject_id = ?
              AND payload_hash = ?
              AND state = 'RECORDED'
          `,
        )
        .run(
          lock.fencingToken,
          submittedAt,
          row.order_id,
          row.payload_hash,
        );

      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    assertCurrentAccountLock(database, lock, submittedAt);

    const beforeCall = readExecutionRow(database, poId);
    if (beforeCall.remote_status !== "ACCEPTED") {
      cancelBeforeProviderCall(database, poId, submittedAt);
      return;
    }

    const request = requestFromExecution(
      beforeCall,
      submittedAt,
    );
    providerCalled = true;
    let result: SupplierPurchaseResult;
    try {
      result = adapter.submit(request);
    } catch (error) {
      markPurchaseUnknown(database, poId, submittedAt);
      throw error;
    }

    const afterCall = readExecutionRow(database, poId);
    if (
      result.state === "CONFIRMED" &&
      afterCall.remote_status !== "ACCEPTED"
    ) {
      const exceptionId = deterministicId(
        "exception",
        afterCall.order_id,
        "CANCELLED_AFTER_PURCHASE",
      );
      database
        .prepare(
          `
            INSERT INTO exceptions (
              id,
              order_id,
              exception_type,
              owner,
              deadline_at,
              safe_next_action,
              exposure_reserved,
              state,
              created_at,
              resolved_at
            ) VALUES (
              ?, ?, 'CANCELLED_AFTER_PURCHASE', 'OWNER',
              ?, ?, 1, 'OPEN', ?, NULL
            )
            ON CONFLICT(id) DO NOTHING
          `,
        )
        .run(
          exceptionId,
          afterCall.order_id,
          submittedAt,
          "Supplier purchase may exist after marketplace cancellation; do not release exposure until disposition is reconciled.",
          submittedAt,
        );
    }

    assertCurrentAccountLock(database, lock, submittedAt);
    finalizeProviderResult(
      database,
      poId,
      result,
      submittedAt,
    );
  } catch (error) {
    if (providerCalled) {
      const latest = readExecutionRow(database, poId);
      if (latest.po_state === "SUBMITTING") {
        markPurchaseUnknown(database, poId, submittedAt);
      }
    }
    throw error;
  } finally {
    try {
      releaseAccountLock(database, lock, submittedAt);
    } catch {
      // A takeover/expiry is already a safety signal; reconciliation owns
      // any unresolved SUBMITTING state.
    }
  }
}

export function reconcilePurchase(
  database: DatabaseSync,
  poId: string,
  adapter: SupplierPurchaseAdapter,
  reconciledAt: string,
): boolean {
  const row = readExecutionRow(database, poId);
  if (
    row.po_state !== "SUBMITTING" &&
    row.po_state !== "PURCHASE_UNKNOWN"
  ) {
    return false;
  }

  const request = requestFromExecution(row, reconciledAt);
  const result = adapter.reconcile(request);

  if (result.state === "UNKNOWN") {
    if (row.po_state === "SUBMITTING") {
      markPurchaseUnknown(
        database,
        poId,
        reconciledAt,
      );
    }
    return false;
  }

  finalizeProviderResult(
    database,
    poId,
    result,
    reconciledAt,
  );
  return true;
}

export function reconcileUnknownPurchase(
  database: DatabaseSync,
  poId: string,
  adapter: SupplierPurchaseAdapter,
  reconciledAt: string,
): boolean {
  return reconcilePurchase(
    database,
    poId,
    adapter,
    reconciledAt,
  );
}
