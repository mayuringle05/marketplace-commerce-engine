import type { DatabaseSync } from "node:sqlite";

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
  readonly units: number;
  readonly cashPaise: number;
  readonly availableCashPaise: number;
  readonly identityOk: boolean;
  readonly sourceFresh: boolean;
  readonly economicsOk: boolean;
  readonly routeOk: boolean;
  readonly authorizedAt: string;
}

export function validateAndAuthorizeOrder(
  database: DatabaseSync,
  input: OrderAuthorizationInput,
): void {
  let order = readOrder(database, input.orderId);

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

  createReservation(database, {
    orderId: input.orderId,
    sourceOfferId: input.sourceOfferId,
    units: input.units,
    cashPaise: input.cashPaise,
    availableCashPaise: input.availableCashPaise,
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

  let failure: OrderState | null = null;
  if (!input.identityOk) {
    failure = "IDENTITY_CONFLICT";
  } else if (!input.sourceFresh || !input.economicsOk) {
    failure = "PRICE_BREACH";
  } else if (!input.routeOk) {
    failure = "SLA_BREACH";
  }

  if (failure !== null) {
    transitionOrder(
      database,
      input.orderId,
      "VALIDATING",
      version,
      failure,
      input.authorizedAt,
    );
    return;
  }

  transitionOrder(
    database,
    input.orderId,
    "VALIDATING",
    version,
    "AUTHORIZED",
    input.authorizedAt,
  );
}
