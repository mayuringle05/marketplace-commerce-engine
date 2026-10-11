import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";
import { readCashAvailability } from "../cash/state.ts";
import {
  markStockCommitmentReserved,
  consumeStockCommitments,
  releaseStockCommitments,
  supplyPoolIdForOffer,
} from "../supplier/pools.ts";

export interface ReservationInput {
  readonly orderId: string;
  readonly sourceOfferId: string;
  readonly cashPaise: number;
  readonly createdAt: string;
}

export function createReservation(
  database: DatabaseSync,
  input: ReservationInput,
): string {
  if (
    !Number.isSafeInteger(input.cashPaise) ||
    input.cashPaise < 0
  ) {
    throw new Error("Reservation cash must be a non-negative integer.");
  }

  const poolId = supplyPoolIdForOffer(
    database,
    input.sourceOfferId,
  );

  const items = database
    .prepare(
      `
        SELECT
          i.id,
          i.quantity,
          c.supply_pool_id,
          c.units,
          c.state
        FROM order_items i
        JOIN stock_commitments c
          ON c.order_item_id = i.id
        WHERE i.order_id = ?
      `,
    )
    .all(input.orderId) as Array<{
    id: string;
    quantity: bigint;
    supply_pool_id: string;
    units: bigint;
    state: string;
  }>;

  if (items.length !== 1) {
    throw new Error(
      "V1 reservation requires exactly one marketplace order item.",
    );
  }

  const item = items[0];
  if (
    item === undefined ||
    item.supply_pool_id !== poolId ||
    item.units !== item.quantity ||
    item.state !== "ACCEPTED"
  ) {
    throw new Error(
      "Accepted stock commitment does not match the source offer.",
    );
  }

  const cash = readCashAvailability(
    database,
    input.createdAt,
  );
  if (BigInt(input.cashPaise) > cash.uncommittedCashPaise) {
    throw new Error("Insufficient shared verified cash.");
  }

  const id = deterministicId(
    "reservation",
    input.orderId,
    poolId,
  );

  const existing = database
    .prepare(
      `
        SELECT
          source_offer_id,
          supply_pool_id,
          units,
          cash_paise,
          status
        FROM reservations
        WHERE order_id = ?
          AND supply_pool_id = ?
      `,
    )
    .get(input.orderId, poolId) as
    | {
        source_offer_id: string;
        supply_pool_id: string;
        units: bigint;
        cash_paise: bigint;
        status: string;
      }
    | undefined;

  if (existing !== undefined) {
    if (
      existing.source_offer_id !== input.sourceOfferId ||
      existing.units !== item.quantity ||
      existing.cash_paise !== BigInt(input.cashPaise) ||
      existing.status !== "ACTIVE"
    ) {
      throw new Error("Conflicting reservation replay.");
    }
    return id;
  }

  database
    .prepare(
      `
        INSERT INTO reservations (
          id,
          order_id,
          source_offer_id,
          units,
          cash_paise,
          status,
          created_at,
          updated_at,
          supply_pool_id
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      `,
    )
    .run(
      id,
      input.orderId,
      input.sourceOfferId,
      item.quantity,
      input.cashPaise,
      input.createdAt,
      input.createdAt,
      poolId,
    );

  markStockCommitmentReserved(
    database,
    item.id,
    input.createdAt,
  );

  return id;
}

export function consumeReservation(
  database: DatabaseSync,
  orderId: string,
  consumedAt: string,
): void {
  const result = database
    .prepare(
      `
        UPDATE reservations
        SET
          status = 'CONSUMED',
          updated_at = ?
        WHERE order_id = ?
          AND status = 'ACTIVE'
      `,
    )
    .run(consumedAt, orderId);

  if (result.changes === 0n) {
    return;
  }

  consumeStockCommitments(database, orderId, consumedAt);
}

export function releaseReservation(
  database: DatabaseSync,
  orderId: string,
  releasedAt: string,
): void {
  database
    .prepare(
      `
        UPDATE reservations
        SET
          status = 'RELEASED',
          updated_at = ?
        WHERE order_id = ?
          AND status = 'ACTIVE'
      `,
    )
    .run(releasedAt, orderId);

  releaseStockCommitments(database, orderId, releasedAt);
}
