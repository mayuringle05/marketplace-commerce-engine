import type { DatabaseSync } from "node:sqlite";

import { appendAuditEvent } from "../core/audit.ts";

export interface RemoteListing {
  readonly marketplace: string;
  readonly sellerSku: string;
  readonly pricePaise: bigint;
  readonly quantity: bigint;
  readonly state: "ACTIVE" | "PAUSED";
  readonly remoteVersion: bigint;
}

export function upsertSimulatedListing(
  database: DatabaseSync,
  marketplace: string,
  sellerSku: string,
  pricePaise: number,
  quantity: number,
  state: "ACTIVE" | "PAUSED",
  updatedAt: string,
): RemoteListing {
  const existing = database
    .prepare(
      `
        SELECT remote_version
        FROM simulated_marketplace_listings
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .get(marketplace, sellerSku) as
    | { remote_version: bigint }
    | undefined;

  const version = (existing?.remote_version ?? 0n) + 1n;

  database
    .prepare(
      `
        INSERT INTO simulated_marketplace_listings (
          marketplace,
          seller_sku,
          price_paise,
          quantity,
          state,
          remote_version,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(marketplace, seller_sku) DO UPDATE SET
          price_paise = excluded.price_paise,
          quantity = excluded.quantity,
          state = excluded.state,
          remote_version = excluded.remote_version,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      marketplace,
      sellerSku,
      pricePaise,
      quantity,
      state,
      version,
      updatedAt,
    );

  appendAuditEvent(database, {
    eventType: "SIM_MARKETPLACE_LISTING_UPSERT",
    subjectType: "listing",
    subjectId: `${marketplace}:${sellerSku}`,
    payload: {
      pricePaise,
      quantity,
      state,
      remoteVersion: version.toString(),
    },
    occurredAt: updatedAt,
  });

  return readSimulatedListing(database, marketplace, sellerSku);
}

export function readSimulatedListing(
  database: DatabaseSync,
  marketplace: string,
  sellerSku: string,
): RemoteListing {
  const row = database
    .prepare(
      `
        SELECT
          marketplace,
          seller_sku,
          price_paise,
          quantity,
          state,
          remote_version
        FROM simulated_marketplace_listings
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .get(marketplace, sellerSku) as
    | {
        marketplace: string;
        seller_sku: string;
        price_paise: bigint;
        quantity: bigint;
        state: "ACTIVE" | "PAUSED";
        remote_version: bigint;
      }
    | undefined;

  if (row === undefined) {
    throw new Error("Simulated remote listing not found.");
  }

  return {
    marketplace: row.marketplace,
    sellerSku: row.seller_sku,
    pricePaise: row.price_paise,
    quantity: row.quantity,
    state: row.state,
    remoteVersion: row.remote_version,
  };
}
