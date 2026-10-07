import type { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  deterministicId,
} from "../core/deterministic.ts";

export interface MarketplaceOrderEvent {
  readonly marketplace: string;
  readonly marketplaceOrderId: string;
  readonly marketplaceItemId: string;
  readonly sellerSku: string;
  readonly quantity: number;
  readonly acceptedPricePaise: number;
  readonly receivedAt: string;
  readonly economicsSnapshot: unknown;
}

interface ListingRow {
  readonly id: string;
  readonly marketplace_catalogue_item_id: string;
  readonly supply_pool_id: string | null;
  readonly observed_quantity: bigint | null;
  readonly desired_price_paise: bigint;
}

function openOversellException(
  database: DatabaseSync,
  orderId: string,
  reason: string,
  at: string,
): void {
  const id = deterministicId(
    "exception",
    orderId,
    "ACCEPTED_ORDER_CAPACITY_MISMATCH",
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
          ?, ?,
          'ACCEPTED_ORDER_CAPACITY_MISMATCH',
          'OWNER',
          ?,
          ?,
          1,
          'OPEN',
          ?,
          NULL
        )
        ON CONFLICT(id) DO NOTHING
      `,
    )
    .run(
      id,
      orderId,
      at,
      reason,
      at,
    );
}

export function ingestMarketplaceOrder(
  database: DatabaseSync,
  event: MarketplaceOrderEvent,
): string {
  if (
    !Number.isSafeInteger(event.quantity) ||
    event.quantity <= 0 ||
    !Number.isSafeInteger(event.acceptedPricePaise) ||
    event.acceptedPricePaise < 0 ||
    event.marketplaceItemId.trim().length === 0
  ) {
    throw new Error(
      "Order item requires positive quantity, non-negative price, and external item ID.",
    );
  }

  const listing = database
    .prepare(
      `
        SELECT
          id,
          marketplace_catalogue_item_id,
          supply_pool_id,
          observed_quantity,
          desired_price_paise
        FROM listings
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .get(event.marketplace, event.sellerSku) as
    | ListingRow
    | undefined;

  if (listing === undefined || listing.supply_pool_id === null) {
    throw new Error(
      "Order references unknown or unbound seller SKU.",
    );
  }

  const tradeUnit = database
    .prepare(
      `
        SELECT trade_unit_id
        FROM marketplace_catalogue_items
        WHERE id = ?
      `,
    )
    .get(listing.marketplace_catalogue_item_id) as
    | { trade_unit_id: string }
    | undefined;

  if (tradeUnit === undefined) {
    throw new Error("Marketplace catalogue mapping missing.");
  }

  const orderId = deterministicId(
    "order",
    event.marketplace,
    event.marketplaceOrderId,
  );
  const itemId = deterministicId(
    "orderitem",
    orderId,
    event.marketplaceItemId,
  );
  const economicsJson = canonicalJson(event.economicsSnapshot);

  database.exec("BEGIN IMMEDIATE");
  try {
    const orderInsert = database
      .prepare(
        `
          INSERT INTO orders (
            id,
            marketplace,
            marketplace_order_id,
            state,
            version,
            received_at,
            updated_at,
            immutable_economics_json
          ) VALUES (?, ?, ?, 'RECEIVED', 1, ?, ?, ?)
          ON CONFLICT(marketplace, marketplace_order_id) DO NOTHING
        `,
      )
      .run(
        orderId,
        event.marketplace,
        event.marketplaceOrderId,
        event.receivedAt,
        event.receivedAt,
        economicsJson,
      );

    if (orderInsert.changes === 0n) {
      const existingOrder = database
        .prepare(
          `
            SELECT immutable_economics_json
            FROM orders
            WHERE marketplace = ?
              AND marketplace_order_id = ?
          `,
        )
        .get(
          event.marketplace,
          event.marketplaceOrderId,
        ) as
        | { immutable_economics_json: string }
        | undefined;

      if (
        existingOrder === undefined ||
        existingOrder.immutable_economics_json !== economicsJson
      ) {
        throw new Error(
          "Conflicting replay for marketplace order.",
        );
      }
    } else {
      database
        .prepare(
          `
            INSERT INTO simulated_marketplace_orders (
              marketplace,
              marketplace_order_id,
              status,
              updated_at
            ) VALUES (?, ?, 'ACCEPTED', ?)
            ON CONFLICT(marketplace, marketplace_order_id)
            DO NOTHING
          `,
        )
        .run(
          event.marketplace,
          event.marketplaceOrderId,
          event.receivedAt,
        );
    }

    const existingItem = database
      .prepare(
        `
          SELECT
            listing_id,
            trade_unit_id,
            quantity,
            accepted_price_paise
          FROM order_items
          WHERE order_id = ?
            AND marketplace_item_id = ?
        `,
      )
      .get(orderId, event.marketplaceItemId) as
      | {
          listing_id: string;
          trade_unit_id: string;
          quantity: bigint;
          accepted_price_paise: bigint;
        }
      | undefined;

    if (existingItem !== undefined) {
      if (
        existingItem.listing_id !== listing.id ||
        existingItem.trade_unit_id !== tradeUnit.trade_unit_id ||
        existingItem.quantity !== BigInt(event.quantity) ||
        existingItem.accepted_price_paise !==
          BigInt(event.acceptedPricePaise)
      ) {
        throw new Error(
          "Conflicting replay for marketplace order item.",
        );
      }

      database.exec("COMMIT");
      return orderId;
    }

    database
      .prepare(
        `
          INSERT INTO order_items (
            id,
            order_id,
            listing_id,
            trade_unit_id,
            quantity,
            accepted_price_paise,
            marketplace_item_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        itemId,
        orderId,
        listing.id,
        tradeUnit.trade_unit_id,
        event.quantity,
        event.acceptedPricePaise,
        event.marketplaceItemId,
      );

    database
      .prepare(
        `
          INSERT INTO stock_commitments (
            order_item_id,
            supply_pool_id,
            units,
            state,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, 'ACCEPTED', ?, ?)
        `,
      )
      .run(
        itemId,
        listing.supply_pool_id,
        event.quantity,
        event.receivedAt,
        event.receivedAt,
      );

    const quantity = BigInt(event.quantity);
    const observed = listing.observed_quantity ?? 0n;
    const remaining = observed > quantity
      ? observed - quantity
      : 0n;
    const listingState =
      remaining === 0n ? "PAUSED" : "ACTIVE";

    database
      .prepare(
        `
          UPDATE listings
          SET
            desired_quantity = ?,
            observed_quantity = ?,
            desired_state = ?,
            observed_state = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        remaining,
        remaining,
        listingState,
        listingState,
        event.receivedAt,
        listing.id,
      );

    database
      .prepare(
        `
          UPDATE simulated_marketplace_listings
          SET
            quantity = ?,
            state = ?,
            remote_version = remote_version + 1,
            updated_at = ?
          WHERE marketplace = ?
            AND seller_sku = ?
        `,
      )
      .run(
        remaining,
        listingState,
        event.receivedAt,
        event.marketplace,
        event.sellerSku,
      );

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
      .get(listing.supply_pool_id) as {
      allocated_units: bigint;
      available_units: bigint;
      consumed_units: bigint;
    };

    const committed = database
      .prepare(
        `
          SELECT COALESCE(SUM(units), 0) AS units
          FROM stock_commitments
          WHERE supply_pool_id = ?
            AND state IN ('ACCEPTED', 'RESERVED')
        `,
      )
      .get(listing.supply_pool_id) as { units: bigint };

    const ceiling =
      pool.allocated_units < pool.available_units
        ? pool.allocated_units
        : pool.available_units;

    if (
      observed < quantity ||
      pool.consumed_units + committed.units > ceiling
    ) {
      openOversellException(
        database,
        orderId,
        "Authoritative order exceeds locally conserved stock. Preserve the order, keep exposure paused, and resolve supply before procurement.",
        event.receivedAt,
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return orderId;
}
