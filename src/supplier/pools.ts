import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  deterministicId,
} from "../core/deterministic.ts";

export interface SupplyPoolCapacity {
  readonly poolId: string;
  readonly allocatedUnits: bigint;
  readonly availableUnits: bigint;
  readonly consumedUnits: bigint;
  readonly committedUnits: bigint;
  readonly safetyUnits: bigint;
  readonly publicCapacityUnits: bigint;
}

export function supplyPoolIdForOffer(
  database: DatabaseSync,
  sourceOfferId: string,
): string {
  const row = database
    .prepare(
      `
        SELECT pool_id
        FROM source_offer_supply_pools
        WHERE offer_id = ?
      `,
    )
    .get(sourceOfferId) as { pool_id: string } | undefined;

  if (row === undefined) {
    throw new Error("Source offer is not linked to a supply pool.");
  }
  return row.pool_id;
}

export function readSupplyPoolCapacity(
  database: DatabaseSync,
  poolId: string,
  safetyUnits = 1n,
): SupplyPoolCapacity {
  if (safetyUnits < 0n) {
    throw new Error("Safety units must be non-negative.");
  }

  const pool = database
    .prepare(
      `
        SELECT
          allocated_units,
          available_units,
          consumed_units
        FROM supply_pools
        WHERE id = ?
      `,
    )
    .get(poolId) as
    | {
        allocated_units: bigint;
        available_units: bigint;
        consumed_units: bigint;
      }
    | undefined;

  if (pool === undefined) {
    throw new Error("Supply pool not found.");
  }

  const commitments = database
    .prepare(
      `
        SELECT COALESCE(SUM(units), 0) AS units
        FROM stock_commitments
        WHERE supply_pool_id = ?
          AND state IN ('ACCEPTED', 'RESERVED')
      `,
    )
    .get(poolId) as { units: bigint };

  const held = database
    .prepare(
      `
        SELECT COALESCE(SUM(quantity), 0) AS units
        FROM marketplace_order_obligations
        WHERE supply_pool_id = ?
          AND state = 'HELD_MULTI_ITEM'
      `,
    )
    .get(poolId) as { units: bigint };

  const conservedCommitments =
    commitments.units + held.units;
  const byAllocation =
    pool.allocated_units -
    pool.consumed_units -
    conservedCommitments -
    safetyUnits;
  const byAvailability =
    pool.available_units -
    pool.consumed_units -
    conservedCommitments -
    safetyUnits;
  const capacity =
    byAllocation < byAvailability ? byAllocation : byAvailability;

  return {
    poolId,
    allocatedUnits: pool.allocated_units,
    availableUnits: pool.available_units,
    consumedUnits: pool.consumed_units,
    committedUnits: conservedCommitments,
    safetyUnits,
    publicCapacityUnits: capacity > 0n ? capacity : 0n,
  };
}

export function markStockCommitmentReserved(
  database: DatabaseSync,
  orderItemId: string,
  updatedAt: string,
): void {
  const result = database
    .prepare(
      `
        UPDATE stock_commitments
        SET state = 'RESERVED', updated_at = ?
        WHERE order_item_id = ?
          AND state = 'ACCEPTED'
      `,
    )
    .run(updatedAt, orderItemId);

  if (result.changes !== 1n) {
    throw new Error("Accepted stock commitment is missing.");
  }
}

export function consumeStockCommitments(
  database: DatabaseSync,
  orderId: string,
  consumedAt: string,
): void {
  const rows = database
    .prepare(
      `
        SELECT
          c.order_item_id,
          c.supply_pool_id,
          c.units
        FROM stock_commitments c
        JOIN order_items i
          ON i.id = c.order_item_id
        WHERE i.order_id = ?
          AND c.state = 'RESERVED'
      `,
    )
    .all(orderId) as Array<{
    order_item_id: string;
    supply_pool_id: string;
    units: bigint;
  }>;

  if (rows.length === 0) {
    const consumed = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM stock_commitments c
          JOIN order_items i
            ON i.id = c.order_item_id
          WHERE i.order_id = ?
            AND c.state = 'CONSUMED'
        `,
      )
      .get(orderId) as { count: bigint };

    if (consumed.count > 0n) {
      return;
    }
    throw new Error("No reserved stock commitment to consume.");
  }

  for (const row of rows) {
    const result = database
      .prepare(
        `
          UPDATE supply_pools
          SET
            consumed_units = consumed_units + ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ?
            AND consumed_units + ? <= allocated_units
        `,
      )
      .run(
        row.units,
        consumedAt,
        row.supply_pool_id,
        row.units,
      );

    if (result.changes !== 1n) {
      throw new Error("Supply-pool consumption would exceed allocation.");
    }

    database
      .prepare(
        `
          UPDATE stock_commitments
          SET state = 'CONSUMED', updated_at = ?
          WHERE order_item_id = ?
            AND state = 'RESERVED'
        `,
      )
      .run(consumedAt, row.order_item_id);
  }
}

export function releaseStockCommitments(
  database: DatabaseSync,
  orderId: string,
  releasedAt: string,
): void {
  database
    .prepare(
      `
        UPDATE stock_commitments
        SET state = 'RELEASED', updated_at = ?
        WHERE order_item_id IN (
          SELECT id
          FROM order_items
          WHERE order_id = ?
        )
          AND state IN ('ACCEPTED', 'RESERVED')
      `,
    )
    .run(releasedAt, orderId);
}

export function recordSupplyReplenishment(
  database: DatabaseSync,
  poolId: string,
  units: number,
  evidenceRef: string,
  observedAt: string,
): string {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new Error("Replenishment units must be positive.");
  }
  assertCanonicalUtcTimestamp(observedAt, "observedAt");
  if (evidenceRef.trim().length === 0) {
    throw new Error("Replenishment evidence is required.");
  }

  const id = deterministicId(
    "replenishment",
    poolId,
    evidenceRef,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    const insert = database
      .prepare(
        `
          INSERT OR IGNORE INTO supply_replenishment_events (
            id,
            supply_pool_id,
            units,
            evidence_ref,
            observed_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(id, poolId, units, evidenceRef, observedAt);

    if (insert.changes === 1n) {
      database
        .prepare(
          `
            UPDATE supply_pools
            SET
              consumed_units = MAX(consumed_units - ?, 0),
              version = version + 1,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(units, observedAt, poolId);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return id;
}
