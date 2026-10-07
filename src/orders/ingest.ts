import type { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  deterministicId,
  sha256Hex,
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
}

function openOrderException(
  database: DatabaseSync,
  orderId: string,
  exceptionType: string,
  reason: string,
  at: string,
): void {
  const id = deterministicId(
    "exception",
    orderId,
    exceptionType,
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
        ) VALUES (?, ?, ?, 'OWNER', ?, ?, 1, 'OPEN', ?, NULL)
        ON CONFLICT(id) DO NOTHING
      `,
    )
    .run(
      id,
      orderId,
      exceptionType,
      at,
      reason,
      at,
    );
}

function pauseListingLocallyAndRemotely(
  database: DatabaseSync,
  listingId: string,
  marketplace: string,
  sellerSku: string,
  at: string,
): void {
  database
    .prepare(
      `
        UPDATE listings
        SET
          desired_quantity = 0,
          observed_quantity = 0,
          desired_state = 'PAUSED',
          observed_state = 'PAUSED',
          version = version + 1,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .run(at, listingId);

  database
    .prepare(
      `
        UPDATE simulated_marketplace_listings
        SET
          quantity = 0,
          state = 'PAUSED',
          remote_version = remote_version + 1,
          updated_at = ?
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .run(at, marketplace, sellerSku);
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
          observed_quantity
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
  const obligationId = deterministicId(
    "obligation",
    orderId,
    event.marketplaceItemId,
  );
  const economicsJson = canonicalJson(event.economicsSnapshot);
  const itemPayloadHash = sha256Hex(
    canonicalJson({
      marketplace: event.marketplace,
      marketplaceOrderId: event.marketplaceOrderId,
      marketplaceItemId: event.marketplaceItemId,
      sellerSku: event.sellerSku,
      listingId: listing.id,
      tradeUnitId: tradeUnit.trade_unit_id,
      supplyPoolId: listing.supply_pool_id,
      quantity: event.quantity,
      acceptedPricePaise: event.acceptedPricePaise,
    }),
  );

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

    const existingObligation = database
      .prepare(
        `
          SELECT payload_hash
          FROM marketplace_order_obligations
          WHERE order_id = ?
            AND marketplace_item_id = ?
        `,
      )
      .get(orderId, event.marketplaceItemId) as
      | { payload_hash: string }
      | undefined;

    if (existingObligation !== undefined) {
      if (existingObligation.payload_hash !== itemPayloadHash) {
        throw new Error(
          "Conflicting replay for marketplace order item.",
        );
      }
      database.exec("COMMIT");
      return orderId;
    }

    const sameListingItem = database
      .prepare(
        `
          SELECT id
          FROM order_items
          WHERE order_id = ?
            AND listing_id = ?
          LIMIT 1
        `,
      )
      .get(orderId, listing.id) as { id: string } | undefined;

    if (sameListingItem !== undefined) {
      database
        .prepare(
          `
            INSERT INTO marketplace_order_obligations (
              id,
              order_id,
              marketplace_item_id,
              seller_sku,
              supply_pool_id,
              quantity,
              accepted_price_paise,
              payload_hash,
              state,
              order_item_id,
              created_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?,
              'HELD_MULTI_ITEM', NULL, ?
            )
          `,
        )
        .run(
          obligationId,
          orderId,
          event.marketplaceItemId,
          event.sellerSku,
          listing.supply_pool_id,
          event.quantity,
          event.acceptedPricePaise,
          itemPayloadHash,
          event.receivedAt,
        );

      pauseListingLocallyAndRemotely(
        database,
        listing.id,
        event.marketplace,
        event.sellerSku,
        event.receivedAt,
      );
      openOrderException(
        database,
        orderId,
        "UNSUPPORTED_MULTI_ITEM_ORDER",
        "A second marketplace item for the same seller SKU was accepted. Preserve both obligations, keep exposure paused, and require explicit owner handling before procurement.",
        event.receivedAt,
      );

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
          INSERT INTO marketplace_order_obligations (
            id,
            order_id,
            marketplace_item_id,
            seller_sku,
            supply_pool_id,
            quantity,
            accepted_price_paise,
            payload_hash,
            state,
            order_item_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MAPPED', ?, ?)
        `,
      )
      .run(
        obligationId,
        orderId,
        event.marketplaceItemId,
        event.sellerSku,
        listing.supply_pool_id,
        event.quantity,
        event.acceptedPricePaise,
        itemPayloadHash,
        itemId,
        event.receivedAt,
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
    const remaining =
      observed > quantity ? observed - quantity : 0n;
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
          SELECT
            COALESCE(
              (
                SELECT SUM(units)
                FROM stock_commitments
                WHERE supply_pool_id = ?
                  AND state IN ('ACCEPTED', 'RESERVED')
              ),
              0
            ) +
            COALESCE(
              (
                SELECT SUM(quantity)
                FROM marketplace_order_obligations
                WHERE supply_pool_id = ?
                  AND state = 'HELD_MULTI_ITEM'
              ),
              0
            ) AS units
        `,
      )
      .get(
        listing.supply_pool_id,
        listing.supply_pool_id,
      ) as { units: bigint };

    const ceiling =
      pool.allocated_units < pool.available_units
        ? pool.allocated_units
        : pool.available_units;

    if (
      observed < quantity ||
      pool.consumed_units + committed.units > ceiling
    ) {
      openOrderException(
        database,
        orderId,
        "ACCEPTED_ORDER_CAPACITY_MISMATCH",
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
