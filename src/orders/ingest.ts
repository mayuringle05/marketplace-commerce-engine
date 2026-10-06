import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, deterministicId } from "../core/deterministic.ts";

export interface MarketplaceOrderEvent {
  readonly marketplace: string;
  readonly marketplaceOrderId: string;
  readonly sellerSku: string;
  readonly quantity: number;
  readonly acceptedPricePaise: number;
  readonly receivedAt: string;
  readonly economicsSnapshot: unknown;
}

export function ingestMarketplaceOrder(
  database: DatabaseSync,
  event: MarketplaceOrderEvent,
): string {
  if (!Number.isSafeInteger(event.quantity) || event.quantity <= 0) {
    throw new Error("Order quantity must be a positive integer.");
  }

  const listing = database
    .prepare(
      `
        SELECT
          id,
          marketplace_catalogue_item_id
        FROM listings
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .get(event.marketplace, event.sellerSku) as
    | { id: string; marketplace_catalogue_item_id: string }
    | undefined;

  if (listing === undefined) {
    throw new Error("Order references unknown seller SKU.");
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
  const itemId = deterministicId("orderitem", orderId, listing.id);

  database.exec("BEGIN IMMEDIATE");
  try {
    database
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
        canonicalJson(event.economicsSnapshot),
      );

    database
      .prepare(
        `
          INSERT OR IGNORE INTO order_items (
            id,
            order_id,
            listing_id,
            trade_unit_id,
            quantity,
            accepted_price_paise
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        itemId,
        orderId,
        listing.id,
        tradeUnit.trade_unit_id,
        event.quantity,
        event.acceptedPricePaise,
      );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return orderId;
}
