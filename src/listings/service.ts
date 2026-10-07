import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";
import {
  readSimulatedListing,
  upsertSimulatedListing,
} from "../marketplace/simulated.ts";
import { readRuntimeSafety } from "../runtime/safety.ts";

export interface ListingSyncInput {
  readonly marketplace: string;
  readonly sellerSku: string;
  readonly marketplaceCatalogueItemId: string;
  readonly opportunityId: string;
  readonly sourceOfferId: string;
  readonly pricePaise: number;
  readonly requestedQuantity: number;
  readonly cashExposureLimitUnits: number;
  readonly updatedAt: string;
}

function activeReservedUnits(
  database: DatabaseSync,
  sourceOfferId: string,
): bigint {
  const row = database
    .prepare(
      `
        SELECT COALESCE(SUM(units), 0) AS units
        FROM reservations
        WHERE source_offer_id = ?
          AND status = 'ACTIVE'
      `,
    )
    .get(sourceOfferId) as { units: bigint };

  return row.units;
}

export function syncListingToSimulatedMarketplace(
  database: DatabaseSync,
  input: ListingSyncInput,
): string {
  const safety = readRuntimeSafety(database);
  if (safety.stopNewExposure) {
    throw new Error(
      `New exposure is blocked: ${safety.reason}`,
    );
  }

  const opportunity = database
    .prepare(
      `
        SELECT decision_state, source_offer_id
        FROM opportunities
        WHERE id = ?
      `,
    )
    .get(input.opportunityId) as
    | { decision_state: string; source_offer_id: string }
    | undefined;

  if (
    opportunity === undefined ||
    opportunity.decision_state !== "LIST" ||
    opportunity.source_offer_id !== input.sourceOfferId
  ) {
    throw new Error("Listing requires a persisted LIST opportunity.");
  }

  const mapping = database
    .prepare(
      `
        SELECT
          m.identity_class,
          m.mapping_status AS marketplace_mapping_status,
          t.mapping_status AS trade_unit_mapping_status,
          t.physical_verified_at
        FROM marketplace_catalogue_items m
        JOIN packaged_trade_units t
          ON t.id = m.trade_unit_id
        WHERE m.id = ?
      `,
    )
    .get(input.marketplaceCatalogueItemId) as
    | {
        identity_class: string;
        marketplace_mapping_status: string;
        trade_unit_mapping_status: string;
        physical_verified_at: string | null;
      }
    | undefined;

  if (
    mapping === undefined ||
    !["A", "B"].includes(mapping.identity_class) ||
    mapping.marketplace_mapping_status !== "APPROVED" ||
    mapping.trade_unit_mapping_status !== "APPROVED" ||
    mapping.physical_verified_at === null
  ) {
    throw new Error(
      "Listing requires approved A/B mapping with physical verification.",
    );
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

  const reserved = activeReservedUnits(database, input.sourceOfferId);
  const safetyUnits = 1n;
  const sourceCapacity =
    offer.allocated_units - reserved - safetyUnits;
  const availableCapacity =
    offer.available_units - reserved - safetyUnits;
  const requested = BigInt(input.requestedQuantity);
  const cashLimit = BigInt(input.cashExposureLimitUnits);

  const publicQuantity = [
    sourceCapacity,
    availableCapacity,
    requested,
    cashLimit,
  ].reduce((minimum, value) => (value < minimum ? value : minimum));

  const safeQuantity = publicQuantity > 0n ? publicQuantity : 0n;
  const desiredState = safeQuantity > 0n ? "ACTIVE" : "PAUSED";
  const id = deterministicId(
    "listing",
    input.marketplace,
    input.sellerSku,
  );

  database
    .prepare(
      `
        INSERT INTO listings (
          id,
          marketplace,
          seller_sku,
          marketplace_catalogue_item_id,
          source_offer_id,
          desired_price_paise,
          desired_quantity,
          observed_price_paise,
          observed_quantity,
          desired_state,
          observed_state,
          remote_version,
          version,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'UNKNOWN', NULL, 1, ?)
        ON CONFLICT(marketplace, seller_sku) DO UPDATE SET
          source_offer_id = excluded.source_offer_id,
          desired_price_paise = excluded.desired_price_paise,
          desired_quantity = excluded.desired_quantity,
          desired_state = excluded.desired_state,
          version = listings.version + 1,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      id,
      input.marketplace,
      input.sellerSku,
      input.marketplaceCatalogueItemId,
      input.sourceOfferId,
      input.pricePaise,
      safeQuantity,
      desiredState,
      input.updatedAt,
    );

  const remote = upsertSimulatedListing(
    database,
    input.marketplace,
    input.sellerSku,
    input.pricePaise,
    Number(safeQuantity),
    desiredState,
    input.updatedAt,
  );

  database
    .prepare(
      `
        UPDATE listings
        SET
          observed_price_paise = ?,
          observed_quantity = ?,
          observed_state = ?,
          remote_version = ?,
          updated_at = ?
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .run(
      remote.pricePaise,
      remote.quantity,
      remote.state,
      remote.remoteVersion.toString(),
      input.updatedAt,
      input.marketplace,
      input.sellerSku,
    );

  return id;
}

export function pauseListingAndConfirm(
  database: DatabaseSync,
  marketplace: string,
  sellerSku: string,
  updatedAt: string,
): void {
  const local = database
    .prepare(
      `
        SELECT desired_price_paise
        FROM listings
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .get(marketplace, sellerSku) as
    | { desired_price_paise: bigint }
    | undefined;

  if (local === undefined) {
    throw new Error("Listing not found.");
  }

  database
    .prepare(
      `
        UPDATE listings
        SET
          desired_quantity = 0,
          desired_state = 'PAUSED',
          version = version + 1,
          updated_at = ?
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .run(updatedAt, marketplace, sellerSku);

  upsertSimulatedListing(
    database,
    marketplace,
    sellerSku,
    Number(local.desired_price_paise),
    0,
    "PAUSED",
    updatedAt,
  );

  const remote = readSimulatedListing(
    database,
    marketplace,
    sellerSku,
  );

  if (remote.state !== "PAUSED" || remote.quantity !== 0n) {
    throw new Error("Remote pause acknowledgement not observed.");
  }

  database
    .prepare(
      `
        UPDATE listings
        SET
          observed_quantity = 0,
          observed_state = 'PAUSED',
          remote_version = ?,
          updated_at = ?
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .run(
      remote.remoteVersion.toString(),
      updatedAt,
      marketplace,
      sellerSku,
    );
}

export function pauseAllListingsAndConfirm(
  database: DatabaseSync,
  updatedAt: string,
): number {
  const listings = database
    .prepare(
      `
        SELECT marketplace, seller_sku
        FROM listings
        WHERE desired_state != 'PAUSED'
           OR observed_state != 'PAUSED'
           OR COALESCE(observed_quantity, 0) != 0
        ORDER BY marketplace, seller_sku
      `,
    )
    .all() as Array<{
    marketplace: string;
    seller_sku: string;
  }>;

  for (const listing of listings) {
    pauseListingAndConfirm(
      database,
      listing.marketplace,
      listing.seller_sku,
      updatedAt,
    );
  }

  return listings.length;
}
