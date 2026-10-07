import type { DatabaseSync } from "node:sqlite";

import {
  assertCanonicalUtcTimestamp,
  deterministicId,
} from "../core/deterministic.ts";
import { readCashAvailability } from "../cash/state.ts";
import {
  readSimulatedListing,
  upsertSimulatedListing,
} from "../marketplace/simulated.ts";
import { readRuntimeSafety } from "../runtime/safety.ts";
import { readSupplyPoolCapacity } from "../supplier/pools.ts";

export interface ListingSyncInput {
  readonly marketplace: string;
  readonly sellerSku: string;
  readonly marketplaceCatalogueItemId: string;
  readonly opportunityId: string;
  readonly sourceOfferId: string;
  readonly pricePaise: number;
  readonly requestedQuantity: number;
  readonly updatedAt: string;
}

interface ListingGateRow {
  readonly decision_state: string;
  readonly opportunity_marketplace: string;
  readonly opportunity_product_id: string;
  readonly opportunity_trade_unit_id: string;
  readonly opportunity_source_offer_id: string;
  readonly approved_price_paise: bigint | null;
  readonly required_cash_paise_per_unit: bigint | null;
  readonly source_fresh_until: string | null;
  readonly source_valid_until: string | null;
  readonly mapping_trade_unit_id: string;
  readonly identity_class: string;
  readonly marketplace_mapping_status: string;
  readonly trade_unit_mapping_status: string;
  readonly physical_verified_at: string | null;
  readonly trade_unit_product_id: string;
  readonly source_product_id: string;
  readonly supplier_status: string;
  readonly route_active: bigint;
  readonly single_unit_dispatch_verified: bigint;
  readonly return_route_verified: bigint;
  readonly source_valid_until_actual: string;
  readonly packed_weight_grams: bigint | null;
  readonly package_length_mm: bigint | null;
  readonly package_width_mm: bigint | null;
  readonly package_height_mm: bigint | null;
  readonly pool_id: string;
  readonly latest_offer_id: string | null;
}

function loadListingGate(
  database: DatabaseSync,
  input: ListingSyncInput,
): ListingGateRow {
  const row = database
    .prepare(
      `
        SELECT
          o.decision_state,
          o.marketplace AS opportunity_marketplace,
          o.product_id AS opportunity_product_id,
          o.trade_unit_id AS opportunity_trade_unit_id,
          o.source_offer_id AS opportunity_source_offer_id,
          o.approved_price_paise,
          o.required_cash_paise_per_unit,
          o.source_fresh_until,
          o.source_valid_until,
          m.trade_unit_id AS mapping_trade_unit_id,
          m.identity_class,
          m.mapping_status AS marketplace_mapping_status,
          t.mapping_status AS trade_unit_mapping_status,
          t.physical_verified_at,
          t.product_id AS trade_unit_product_id,
          s.product_id AS source_product_id,
          supplier.status AS supplier_status,
          route.active AS route_active,
          route.single_unit_dispatch_verified,
          route.return_route_verified,
          s.valid_until AS source_valid_until_actual,
          s.packed_weight_grams,
          s.package_length_mm,
          s.package_width_mm,
          s.package_height_mm,
          p.id AS pool_id,
          p.latest_offer_id
        FROM opportunities o
        JOIN marketplace_catalogue_items m
          ON m.id = ?
        JOIN packaged_trade_units t
          ON t.id = m.trade_unit_id
        JOIN source_offers s
          ON s.id = o.source_offer_id
        JOIN suppliers supplier
          ON supplier.id = s.supplier_id
        JOIN fulfilment_routes route
          ON route.id = s.fulfilment_route_id
        JOIN source_offer_supply_pools link
          ON link.offer_id = s.id
        JOIN supply_pools p
          ON p.id = link.pool_id
        WHERE o.id = ?
      `,
    )
    .get(
      input.marketplaceCatalogueItemId,
      input.opportunityId,
    ) as ListingGateRow | undefined;

  if (row === undefined) {
    throw new Error("Listing evidence bundle is incomplete.");
  }
  return row;
}

function assertListingGate(
  input: ListingSyncInput,
  row: ListingGateRow,
): bigint {
  const updatedMs = assertCanonicalUtcTimestamp(
    input.updatedAt,
    "updatedAt",
  );

  if (
    !Number.isSafeInteger(input.pricePaise) ||
    input.pricePaise < 0 ||
    !Number.isSafeInteger(input.requestedQuantity) ||
    input.requestedQuantity < 0
  ) {
    throw new Error("Listing price and quantity must be non-negative integers.");
  }

  if (
    row.decision_state !== "LIST" ||
    row.opportunity_source_offer_id !== input.sourceOfferId ||
    row.opportunity_marketplace !== input.marketplace ||
    row.opportunity_trade_unit_id !== row.mapping_trade_unit_id ||
    row.opportunity_product_id !== row.trade_unit_product_id ||
    row.opportunity_product_id !== row.source_product_id
  ) {
    throw new Error(
      "Listing opportunity, product, trade unit, source offer, or channel does not match.",
    );
  }

  if (
    row.approved_price_paise === null ||
    row.approved_price_paise !== BigInt(input.pricePaise)
  ) {
    throw new Error(
      "Listing price is not the exact price approved by underwriting.",
    );
  }

  if (
    row.required_cash_paise_per_unit === null ||
    row.required_cash_paise_per_unit <= 0n
  ) {
    throw new Error("Opportunity is missing per-unit cash requirement.");
  }

  if (
    row.source_fresh_until === null ||
    row.source_valid_until === null ||
    updatedMs >= new Date(row.source_fresh_until).getTime() ||
    updatedMs >= new Date(row.source_valid_until).getTime() ||
    updatedMs >= new Date(row.source_valid_until_actual).getTime()
  ) {
    throw new Error("Listing source evidence is stale or expired.");
  }

  if (row.latest_offer_id !== input.sourceOfferId) {
    throw new Error(
      "Listing source offer is no longer the latest supplier snapshot.",
    );
  }

  if (
    row.supplier_status !== "verified" ||
    row.route_active !== 1n ||
    row.single_unit_dispatch_verified !== 1n ||
    row.return_route_verified !== 1n
  ) {
    throw new Error("Supplier or fulfilment route is not currently approved.");
  }

  if (
    !["A", "B"].includes(row.identity_class) ||
    row.marketplace_mapping_status !== "APPROVED" ||
    row.trade_unit_mapping_status !== "APPROVED" ||
    row.physical_verified_at === null
  ) {
    throw new Error(
      "Listing requires approved A/B mapping with physical verification.",
    );
  }

  if (
    row.packed_weight_grams === null ||
    row.package_length_mm === null ||
    row.package_width_mm === null ||
    row.package_height_mm === null
  ) {
    throw new Error("Listing source is missing package evidence.");
  }

  return row.required_cash_paise_per_unit;
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

  const gate = loadListingGate(database, input);
  const requiredCashPerUnit = assertListingGate(input, gate);
  const id = deterministicId(
    "listing",
    input.marketplace,
    input.sellerSku,
  );

  const existing = database
    .prepare(
      `
        SELECT id, updated_at
        FROM listings
        WHERE marketplace = ?
          AND seller_sku = ?
      `,
    )
    .get(input.marketplace, input.sellerSku) as
    | { id: string; updated_at: string }
    | undefined;

  if (
    existing !== undefined &&
    input.updatedAt < existing.updated_at
  ) {
    throw new Error("Stale listing mutation rejected.");
  }

  const otherPoolListing = database
    .prepare(
      `
        SELECT id
        FROM listings
        WHERE supply_pool_id = ?
          AND id != ?
        LIMIT 1
      `,
    )
    .get(gate.pool_id, id);

  if (otherPoolListing !== undefined) {
    throw new Error(
      "V1 supply pool is already exposed on another listing/channel.",
    );
  }

  const stock = readSupplyPoolCapacity(
    database,
    gate.pool_id,
    1n,
  );
  const cash = readCashAvailability(
    database,
    input.updatedAt,
    existing?.id ?? null,
  );

  const cashCapacity =
    cash.uncommittedCashPaise / requiredCashPerUnit;
  const requested = BigInt(input.requestedQuantity);
  const safeQuantity = [
    stock.publicCapacityUnits,
    cashCapacity,
    requested,
  ].reduce((minimum, value) =>
    value < minimum ? value : minimum,
  );
  const desiredState =
    safeQuantity > 0n ? "ACTIVE" : "PAUSED";

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
          updated_at,
          supply_pool_id,
          opportunity_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
          ?, 'UNKNOWN', NULL, 1, ?, ?, ?
        )
        ON CONFLICT(marketplace, seller_sku) DO UPDATE SET
          marketplace_catalogue_item_id =
            excluded.marketplace_catalogue_item_id,
          source_offer_id = excluded.source_offer_id,
          desired_price_paise = excluded.desired_price_paise,
          desired_quantity = excluded.desired_quantity,
          desired_state = excluded.desired_state,
          supply_pool_id = excluded.supply_pool_id,
          opportunity_id = excluded.opportunity_id,
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
      gate.pool_id,
      input.opportunityId,
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
