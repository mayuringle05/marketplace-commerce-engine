import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";

export interface ReservationInput {
  readonly orderId: string;
  readonly sourceOfferId: string;
  readonly units: number;
  readonly cashPaise: number;
  readonly availableCashPaise: number;
  readonly createdAt: string;
}

export function createReservation(
  database: DatabaseSync,
  input: ReservationInput,
): string {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new Error("Reservation units must be a positive integer.");
  }
  if (
    !Number.isSafeInteger(input.cashPaise) ||
    input.cashPaise < 0 ||
    !Number.isSafeInteger(input.availableCashPaise) ||
    input.availableCashPaise < 0
  ) {
    throw new Error("Reservation cash values must be non-negative integers.");
  }
  if (input.cashPaise > input.availableCashPaise) {
    throw new Error("Insufficient cash for reservation.");
  }

  const offer = database
    .prepare(
      `
        SELECT allocated_units, available_units
        FROM source_offers
        WHERE id = ?
      `,
    )
    .get(input.sourceOfferId) as
    | { allocated_units: bigint; available_units: bigint }
    | undefined;

  if (offer === undefined) {
    throw new Error("Source offer not found.");
  }

  const row = database
    .prepare(
      `
        SELECT COALESCE(SUM(units), 0) AS units
        FROM reservations
        WHERE source_offer_id = ?
          AND status = 'ACTIVE'
      `,
    )
    .get(input.sourceOfferId) as { units: bigint };

  const requested = BigInt(input.units);
  const remainingAllocated = offer.allocated_units - row.units;
  const remainingAvailable = offer.available_units - row.units;

  if (requested > remainingAllocated || requested > remainingAvailable) {
    throw new Error("Insufficient allocated supplier units.");
  }

  const id = deterministicId(
    "reservation",
    input.orderId,
    input.sourceOfferId,
  );

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
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        ON CONFLICT(order_id, source_offer_id) DO NOTHING
      `,
    )
    .run(
      id,
      input.orderId,
      input.sourceOfferId,
      input.units,
      input.cashPaise,
      input.createdAt,
      input.createdAt,
    );

  return id;
}

export function consumeReservation(
  database: DatabaseSync,
  orderId: string,
  consumedAt: string,
): void {
  database
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
}
