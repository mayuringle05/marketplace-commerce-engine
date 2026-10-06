import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  canonicalJson,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";
import { appendAuditEvent } from "../core/audit.ts";
import {
  transitionOrder,
  type OrderState,
} from "../orders/state-machine.ts";
import {
  reconcileSimulatedPurchase,
  submitSimulatedPurchase,
  type SimulatedPurchaseOutcome,
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
  readonly supplierId: string;
  readonly amountPaise: number;
  readonly quantity: number;
  readonly destinationKey: string;
  readonly authorizationExpiresAt: string;
  readonly createdAt: string;
}

export function recordPurchaseIntent(
  database: DatabaseSync,
  input: PurchaseIntentInput,
): string {
  const order = readOrder(database, input.orderId);
  if (order.state !== "AUTHORIZED") {
    throw new Error("Purchase intent requires AUTHORIZED order.");
  }

  const createdMs = assertCanonicalUtcTimestamp(
    input.createdAt,
    "createdAt",
  );
  const expiresMs = assertCanonicalUtcTimestamp(
    input.authorizationExpiresAt,
    "authorizationExpiresAt",
  );
  if (expiresMs <= createdMs) {
    throw new Error(
      "Purchase authorization expiry must be after creation.",
    );
  }

  const payload = {
    orderId: input.orderId,
    supplierId: input.supplierId,
    amountPaise: input.amountPaise,
    quantity: input.quantity,
    destinationKey: input.destinationKey,
    authorizationExpiresAt: input.authorizationExpiresAt,
  };
  const payloadHash = sha256Hex(canonicalJson(payload));
  const poId = deterministicId("po", input.orderId);
  const clientPoRef = `COSMO-${input.orderId.slice(-12)}`;
  const idempotencyKey = deterministicId(
    "idem",
    input.supplierId,
    clientPoRef,
    payloadHash,
  );
  const intentId = deterministicId(
    "intent",
    "PURCHASE",
    input.orderId,
    payloadHash,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
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
            authorization_expires_at
          ) VALUES (?, ?, ?, ?, NULL, 'INTENT_RECORDED', ?, ?, ?, ?, 1, ?, ?, ?)
        `,
      )
      .run(
        poId,
        input.orderId,
        input.supplierId,
        clientPoRef,
        input.amountPaise,
        input.quantity,
        payloadHash,
        idempotencyKey,
        input.createdAt,
        input.createdAt,
        input.authorizationExpiresAt,
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
          ) VALUES (?, 'PURCHASE', ?, ?, ?, 'RECORDED', 1, NULL, ?, ?)
        `,
      )
      .run(
        intentId,
        input.supplierId,
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
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return poId;
}

export function submitPurchaseOnce(
  database: DatabaseSync,
  poId: string,
  outcome: SimulatedPurchaseOutcome,
  submittedAt: string,
): void {
  const po = database
    .prepare(
      `
        SELECT
          order_id,
          client_po_ref,
          authorized_amount_paise,
          quantity,
          idempotency_key,
          payload_hash,
          supplier_id,
          state,
          authorization_expires_at
        FROM purchase_orders
        WHERE id = ?
      `,
    )
    .get(poId) as
    | {
        order_id: string;
        client_po_ref: string;
        authorized_amount_paise: bigint;
        quantity: bigint;
        idempotency_key: string;
        payload_hash: string;
        supplier_id: string;
        state: string;
        authorization_expires_at: string | null;
      }
    | undefined;

  if (po === undefined) {
    throw new Error("Purchase order not found.");
  }
  if (po.state !== "INTENT_RECORDED") {
    throw new Error("Purchase order is not ready for first submission.");
  }
  if (po.authorization_expires_at === null) {
    throw new Error("Purchase authorization expiry is missing.");
  }

  const submittedMs = assertCanonicalUtcTimestamp(
    submittedAt,
    "submittedAt",
  );
  const expiresMs = assertCanonicalUtcTimestamp(
    po.authorization_expires_at,
    "authorizationExpiresAt",
  );
  if (submittedMs > expiresMs) {
    throw new Error("Purchase authorization has expired.");
  }

  const order = readOrder(database, po.order_id);
  if (order.state !== "PO_INTENT_RECORDED") {
    throw new Error("Order is not ready for purchase submission.");
  }

  const marketplaceOrder = database
    .prepare(
      `
        SELECT
          o.marketplace,
          o.marketplace_order_id,
          r.status
        FROM orders o
        LEFT JOIN simulated_marketplace_orders r
          ON r.marketplace = o.marketplace
          AND r.marketplace_order_id = o.marketplace_order_id
        WHERE o.id = ?
      `,
    )
    .get(po.order_id) as
    | {
        marketplace: string;
        marketplace_order_id: string;
        status: string | null;
      }
    | undefined;

  if (
    marketplaceOrder === undefined ||
    marketplaceOrder.status !== "ACCEPTED"
  ) {
    throw new Error(
      "Authoritative marketplace order is not ACCEPTED; purchase blocked.",
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    transitionOrder(
      database,
      po.order_id,
      "PO_INTENT_RECORDED",
      Number(order.version),
      "PO_SUBMITTING",
      submittedAt,
    );

    database
      .prepare(
        `
          UPDATE purchase_orders
          SET state = 'SUBMITTING', version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'INTENT_RECORDED'
        `,
      )
      .run(submittedAt, poId);

    database
      .prepare(
        `
          UPDATE action_intents
          SET state = 'SUBMITTING', updated_at = ?
          WHERE action_type = 'PURCHASE'
            AND account_scope = ?
            AND subject_id = ?
            AND payload_hash = ?
            AND state = 'RECORDED'
        `,
      )
      .run(
        submittedAt,
        po.supplier_id,
        po.order_id,
        po.payload_hash,
      );

    const result = submitSimulatedPurchase(
      database,
      {
        idempotencyKey: po.idempotency_key,
        clientPoRef: po.client_po_ref,
        amountPaise: Number(po.authorized_amount_paise),
        quantity: Number(po.quantity),
        submittedAt,
      },
      outcome,
    );

    const current = readOrder(database, po.order_id);

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
        .run(result.providerPoId, submittedAt, poId);

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
          submittedAt,
          po.order_id,
          po.payload_hash,
        );

      transitionOrder(
        database,
        po.order_id,
        "PO_SUBMITTING",
        Number(current.version),
        "PO_CONFIRMED",
        submittedAt,
      );
    } else if (result.state === "REJECTED") {
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
        .run(result.providerPoId, submittedAt, poId);

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
          submittedAt,
          po.order_id,
          po.payload_hash,
        );

      transitionOrder(
        database,
        po.order_id,
        "PO_SUBMITTING",
        Number(current.version),
        "SUPPLIER_REJECTED",
        submittedAt,
      );
    } else {
      database
        .prepare(
          `
            UPDATE purchase_orders
            SET
              state = 'PURCHASE_UNKNOWN',
              version = version + 1,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(submittedAt, poId);

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
          `,
        )
        .run(submittedAt, po.order_id, po.payload_hash);

      transitionOrder(
        database,
        po.order_id,
        "PO_SUBMITTING",
        Number(current.version),
        "PAYMENT_UNKNOWN",
        submittedAt,
      );

      const exceptionId = deterministicId(
        "exception",
        po.order_id,
        "PURCHASE_UNKNOWN",
      );
      database
        .prepare(
          `
            INSERT OR IGNORE INTO exceptions (
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
            ) VALUES (?, ?, 'PURCHASE_UNKNOWN', 'OWNER', ?, ?, 1, 'OPEN', ?, NULL)
          `,
        )
        .run(
          exceptionId,
          po.order_id,
          submittedAt,
          "Reconcile supplier order history by exact client PO reference; do not resubmit.",
          submittedAt,
        );
    }

    appendAuditEvent(database, {
      eventType: "PURCHASE_SUBMISSION_RESULT",
      subjectType: "purchase_order",
      subjectId: poId,
      payload: result,
      occurredAt: submittedAt,
    });

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function reconcileUnknownPurchase(
  database: DatabaseSync,
  poId: string,
  reconciledAt: string,
): boolean {
  const po = database
    .prepare(
      `
        SELECT order_id, idempotency_key, state, payload_hash
        FROM purchase_orders
        WHERE id = ?
      `,
    )
    .get(poId) as
    | {
        order_id: string;
        idempotency_key: string;
        state: string;
        payload_hash: string;
      }
    | undefined;

  if (po === undefined || po.state !== "PURCHASE_UNKNOWN") {
    return false;
  }

  const result = reconcileSimulatedPurchase(
    database,
    po.idempotency_key,
  );
  if (result.state === "UNKNOWN") {
    return false;
  }

  const order = readOrder(database, po.order_id);
  if (order.state !== "PAYMENT_UNKNOWN") {
    throw new Error("Unknown purchase order state drift.");
  }

  const nextState =
    result.state === "CONFIRMED"
      ? "PO_CONFIRMED"
      : "SUPPLIER_REJECTED";

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE purchase_orders
          SET
            state = ?,
            provider_po_id = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ?
            AND state = 'PURCHASE_UNKNOWN'
        `,
      )
      .run(
        result.state === "CONFIRMED" ? "CONFIRMED" : "REJECTED",
        result.providerPoId,
        reconciledAt,
        poId,
      );

    database
      .prepare(
        `
          UPDATE action_intents
          SET
            state = ?,
            provider_ref = ?,
            updated_at = ?
          WHERE action_type = 'PURCHASE'
            AND subject_id = ?
            AND payload_hash = ?
        `,
      )
      .run(
        result.state === "CONFIRMED" ? "SUCCEEDED" : "REJECTED",
        result.providerPoId,
        reconciledAt,
        po.order_id,
        po.payload_hash,
      );

    transitionOrder(
      database,
      po.order_id,
      "PAYMENT_UNKNOWN",
      Number(order.version),
      nextState,
      reconciledAt,
    );

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
      .run(reconciledAt, po.order_id);

    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
