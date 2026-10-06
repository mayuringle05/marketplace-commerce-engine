import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  SupplierFeed,
  SupplierFeedOffer,
} from "./feed.ts";

export interface SupplierImportResult {
  readonly inserted: number;
  readonly unchanged: number;
}

interface ExistingOfferRow {
  readonly id: string;
  readonly product_id: string;
  readonly fulfilment_route_id: string | null;
  readonly gross_cost_paise: bigint;
  readonly tax_rate_bps: bigint;
  readonly allocated_units: bigint;
  readonly available_units: bigint;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly source_version: string;
  readonly source_ref: string;
  readonly packed_weight_grams: bigint | null;
  readonly package_length_mm: bigint | null;
  readonly package_width_mm: bigint | null;
  readonly package_height_mm: bigint | null;
}

function deterministicOfferId(
  feed: SupplierFeed,
  offer: SupplierFeedOffer,
): string {
  const digest = createHash("sha256")
    .update(
      [
        feed.supplierId,
        offer.supplierSku,
        feed.sourceVersion,
        feed.observedAt,
      ].join("\u001f"),
    )
    .digest("hex");

  return `offer_${digest.slice(0, 32)}`;
}

function requireSupplier(
  database: DatabaseSync,
  supplierId: string,
): void {
  const row = database
    .prepare("SELECT id FROM suppliers WHERE id = ?")
    .get(supplierId);

  if (row === undefined) {
    throw new Error(`Unknown supplier: ${supplierId}`);
  }
}

function requireProduct(
  database: DatabaseSync,
  productId: string,
): void {
  const row = database
    .prepare("SELECT id FROM products WHERE id = ?")
    .get(productId);

  if (row === undefined) {
    throw new Error(`Unknown product: ${productId}`);
  }
}

function requireSupplierRoute(
  database: DatabaseSync,
  supplierId: string,
  routeId: string,
): void {
  const row = database
    .prepare(
      `
        SELECT id
        FROM fulfilment_routes
        WHERE id = ?
          AND supplier_id = ?
      `,
    )
    .get(routeId, supplierId);

  if (row === undefined) {
    throw new Error(
      `Unknown fulfilment route ${routeId} for supplier ${supplierId}`,
    );
  }
}

function findExisting(
  database: DatabaseSync,
  feed: SupplierFeed,
  offer: SupplierFeedOffer,
): ExistingOfferRow | undefined {
  return database
    .prepare(
      `
        SELECT
          id,
          product_id,
          fulfilment_route_id,
          gross_cost_paise,
          tax_rate_bps,
          allocated_units,
          available_units,
          valid_from,
          valid_until,
          source_version,
          source_ref,
          packed_weight_grams,
          package_length_mm,
          package_width_mm,
          package_height_mm
        FROM source_offers
        WHERE supplier_id = ?
          AND supplier_sku = ?
          AND observed_at = ?
      `,
    )
    .get(
      feed.supplierId,
      offer.supplierSku,
      feed.observedAt,
    ) as ExistingOfferRow | undefined;
}

function replayMatches(
  row: ExistingOfferRow,
  feed: SupplierFeed,
  offer: SupplierFeedOffer,
): boolean {
  return (
    row.product_id === offer.productId &&
    row.fulfilment_route_id === offer.fulfilmentRouteId &&
    row.gross_cost_paise === BigInt(offer.grossCostPaise) &&
    row.tax_rate_bps === BigInt(offer.taxRateBps) &&
    row.allocated_units === BigInt(offer.allocatedUnits) &&
    row.available_units === BigInt(offer.availableUnits) &&
    row.valid_from === offer.validFrom &&
    row.valid_until === offer.validUntil &&
    row.source_version === feed.sourceVersion &&
    row.source_ref === feed.sourceRef &&
    row.packed_weight_grams ===
      BigInt(offer.package.packedWeightGrams) &&
    row.package_length_mm === BigInt(offer.package.lengthMm) &&
    row.package_width_mm === BigInt(offer.package.widthMm) &&
    row.package_height_mm === BigInt(offer.package.heightMm)
  );
}

export function importSupplierFeed(
  database: DatabaseSync,
  feed: SupplierFeed,
): SupplierImportResult {
  requireSupplier(database, feed.supplierId);

  const insert = database.prepare(
    `
      INSERT INTO source_offers (
        id,
        supplier_id,
        product_id,
        supplier_sku,
        gross_cost_paise,
        tax_rate_bps,
        allocated_units,
        available_units,
        valid_from,
        valid_until,
        observed_at,
        source_version,
        source_ref,
        fulfilment_route_id,
        packed_weight_grams,
        package_length_mm,
        package_width_mm,
        package_height_mm
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  let inserted = 0;
  let unchanged = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const offer of feed.offers) {
      requireProduct(database, offer.productId);
      requireSupplierRoute(
        database,
        feed.supplierId,
        offer.fulfilmentRouteId,
      );

      const existing = findExisting(database, feed, offer);

      if (existing !== undefined) {
        if (!replayMatches(existing, feed, offer)) {
          throw new Error(
            `Conflicting replay for supplier SKU ${offer.supplierSku}`,
          );
        }

        unchanged += 1;
        continue;
      }

      insert.run(
        deterministicOfferId(feed, offer),
        feed.supplierId,
        offer.productId,
        offer.supplierSku,
        offer.grossCostPaise,
        offer.taxRateBps,
        offer.allocatedUnits,
        offer.availableUnits,
        offer.validFrom,
        offer.validUntil,
        feed.observedAt,
        feed.sourceVersion,
        feed.sourceRef,
        offer.fulfilmentRouteId,
        offer.package.packedWeightGrams,
        offer.package.lengthMm,
        offer.package.widthMm,
        offer.package.heightMm,
      );
      inserted += 1;
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    inserted,
    unchanged,
  };
}
