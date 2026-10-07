import type { DatabaseSync } from "node:sqlite";

import { appendAuditEvent } from "../core/audit.ts";

export const ORDER_STATES = [
  "RECEIVED",
  "HELD",
  "RESERVED",
  "VALIDATING",
  "AUTHORIZED",
  "PO_INTENT_RECORDED",
  "PO_SUBMITTING",
  "PO_CONFIRMED",
  "PACK_CONFIRMED",
  "HANDOVER_CONFIRMED",
  "IN_TRANSIT",
  "DELIVERED",
  "RTO",
  "LOST",
  "DAMAGED",
  "RECONCILING",
  "MATURED",
  "CUSTOMER_CANCELLED",
  "SUPPLIER_REJECTED",
  "IDENTITY_CONFLICT",
  "PRICE_BREACH",
  "SLA_BREACH",
  "PAYMENT_UNKNOWN",
  "PARTIAL_FULFILMENT",
  "RETURN_OPEN",
  "CLAIM_OPEN",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const ALLOWED: Readonly<Record<OrderState, readonly OrderState[]>> = {
  RECEIVED: ["HELD", "CUSTOMER_CANCELLED"],
  HELD: [
    "RESERVED",
    "CUSTOMER_CANCELLED",
    "IDENTITY_CONFLICT",
    "PRICE_BREACH",
    "SLA_BREACH",
  ],
  RESERVED: ["VALIDATING", "CUSTOMER_CANCELLED"],
  VALIDATING: [
    "AUTHORIZED",
    "IDENTITY_CONFLICT",
    "PRICE_BREACH",
    "SLA_BREACH",
    "CUSTOMER_CANCELLED",
  ],
  AUTHORIZED: ["PO_INTENT_RECORDED", "CUSTOMER_CANCELLED"],
  PO_INTENT_RECORDED: ["PO_SUBMITTING"],
  PO_SUBMITTING: [
    "PO_CONFIRMED",
    "SUPPLIER_REJECTED",
    "PAYMENT_UNKNOWN",
    "CUSTOMER_CANCELLED",
  ],
  PO_CONFIRMED: ["PACK_CONFIRMED", "PARTIAL_FULFILMENT"],
  PACK_CONFIRMED: ["HANDOVER_CONFIRMED"],
  HANDOVER_CONFIRMED: ["IN_TRANSIT"],
  IN_TRANSIT: ["DELIVERED", "RTO", "LOST", "DAMAGED"],
  DELIVERED: ["RECONCILING", "RETURN_OPEN"],
  RTO: ["RECONCILING"],
  LOST: ["CLAIM_OPEN", "RECONCILING"],
  DAMAGED: ["CLAIM_OPEN", "RECONCILING"],
  RECONCILING: ["MATURED", "RETURN_OPEN", "CLAIM_OPEN"],
  MATURED: ["RETURN_OPEN"],
  CUSTOMER_CANCELLED: [],
  SUPPLIER_REJECTED: ["RECONCILING"],
  IDENTITY_CONFLICT: [],
  PRICE_BREACH: [],
  SLA_BREACH: [],
  PAYMENT_UNKNOWN: ["PO_CONFIRMED", "SUPPLIER_REJECTED"],
  PARTIAL_FULFILMENT: ["RECONCILING"],
  RETURN_OPEN: ["RECONCILING"],
  CLAIM_OPEN: ["RECONCILING"],
};

export function canTransitionOrder(
  from: OrderState,
  to: OrderState,
): boolean {
  return ALLOWED[from].includes(to);
}

export function transitionOrder(
  database: DatabaseSync,
  orderId: string,
  expectedState: OrderState,
  expectedVersion: number,
  nextState: OrderState,
  updatedAt: string,
): number {
  if (!canTransitionOrder(expectedState, nextState)) {
    throw new Error(
      `Invalid order transition ${expectedState} -> ${nextState}`,
    );
  }

  const nextVersion = expectedVersion + 1;
  const result = database
    .prepare(
      `
        UPDATE orders
        SET
          state = ?,
          version = ?,
          updated_at = ?
        WHERE id = ?
          AND state = ?
          AND version = ?
      `,
    )
    .run(
      nextState,
      nextVersion,
      updatedAt,
      orderId,
      expectedState,
      expectedVersion,
    );

  if (result.changes !== 1n) {
    throw new Error("Order compare-and-set transition failed.");
  }

  appendAuditEvent(database, {
    eventType: "ORDER_STATE_TRANSITION",
    subjectType: "order",
    subjectId: orderId,
    payload: {
      from: expectedState,
      to: nextState,
      version: nextVersion,
    },
    occurredAt: updatedAt,
  });

  return nextVersion;
}
