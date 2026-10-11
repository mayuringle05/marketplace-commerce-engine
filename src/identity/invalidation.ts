import type { DatabaseSync } from "node:sqlite";

import { pauseListingAndConfirm } from "../listings/service.ts";

export interface MappingInvalidationResult {
  readonly invalidatedMarketplaceMappings: number;
  readonly pausedListings: number;
}

export function invalidateTradeUnitMapping(
  database: DatabaseSync,
  tradeUnitId: string,
  reason: string,
  invalidatedAt: string,
): MappingInvalidationResult {
  if (reason.trim().length === 0) {
    throw new Error("Mapping invalidation reason is required.");
  }

  const tradeUnit = database
    .prepare(
      `
        SELECT mapping_status
        FROM packaged_trade_units
        WHERE id = ?
      `,
    )
    .get(tradeUnitId) as
    | { mapping_status: string }
    | undefined;

  if (tradeUnit === undefined) {
    throw new Error("Trade unit not found.");
  }

  const mappings = database
    .prepare(
      `
        SELECT id
        FROM marketplace_catalogue_items
        WHERE trade_unit_id = ?
          AND mapping_status != 'INVALIDATED'
      `,
    )
    .all(tradeUnitId) as Array<{ id: string }>;

  const listings = database
    .prepare(
      `
        SELECT
          l.marketplace,
          l.seller_sku
        FROM listings l
        JOIN marketplace_catalogue_items m
          ON m.id = l.marketplace_catalogue_item_id
        WHERE m.trade_unit_id = ?
          AND (
            l.desired_state != 'PAUSED' OR
            l.observed_state != 'PAUSED' OR
            l.observed_quantity != 0
          )
      `,
    )
    .all(tradeUnitId) as Array<{
    marketplace: string;
    seller_sku: string;
  }>;

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE packaged_trade_units
          SET
            mapping_status = 'INVALIDATED',
            invalidation_reason = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(reason, invalidatedAt, tradeUnitId);

    const mappingUpdate = database
      .prepare(
        `
          UPDATE marketplace_catalogue_items
          SET
            mapping_status = 'INVALIDATED',
            updated_at = ?
          WHERE trade_unit_id = ?
            AND mapping_status != 'INVALIDATED'
        `,
      )
      .run(invalidatedAt, tradeUnitId);

    for (const listing of listings) {
      pauseListingAndConfirm(
        database,
        listing.marketplace,
        listing.seller_sku,
        invalidatedAt,
      );
    }

    database.exec("COMMIT");

    return {
      invalidatedMarketplaceMappings:
        Number(mappingUpdate.changes),
      pausedListings: listings.length,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
