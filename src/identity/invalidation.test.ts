import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { invalidateTradeUnitMapping } from "./invalidation.ts";

const T0 = "2026-10-07T00:00:00.000Z";

test("invalidating a trade-unit mapping pauses every affected listing", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    database
      .prepare(
        `
          INSERT INTO products (
            id,
            brand,
            manufacturer,
            model,
            mpn,
            condition,
            market_region,
            created_at,
            updated_at
          ) VALUES (
            'product-1',
            'Acme',
            'Acme',
            'Model',
            'MPN',
            'new',
            'IN',
            ?,
            ?
          )
        `,
      )
      .run(T0, T0);

    database
      .prepare(
        `
          INSERT INTO suppliers (
            id,
            legal_name,
            status,
            created_at,
            updated_at
          ) VALUES (
            'supplier-1',
            'Supplier One',
            'verified',
            ?,
            ?
          )
        `,
      )
      .run(T0, T0);

    database
      .prepare(
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
            source_ref
          ) VALUES (
            'offer-1',
            'supplier-1',
            'product-1',
            'SKU-1',
            35000,
            1800,
            5,
            5,
            ?,
            ?,
            ?,
            'v1',
            'fixture'
          )
        `,
      )
      .run(
        "2026-10-07T00:00:00.000Z",
        "2026-10-08T00:00:00.000Z",
        "2026-10-07T00:01:00.000Z",
      );

    database
      .prepare(
        `
          INSERT INTO packaged_trade_units (
            id,
            product_id,
            variant,
            edition,
            pack_count,
            condition,
            market_region,
            barcode_type,
            barcode_value,
            mapping_version,
            mapping_status,
            invalidation_reason,
            created_at,
            updated_at,
            physical_verified_at
          ) VALUES (
            'trade-1',
            'product-1',
            'standard',
            '2026',
            1,
            'new',
            'IN',
            'GTIN13',
            '4006381333931',
            1,
            'APPROVED',
            NULL,
            ?,
            ?,
            ?
          )
        `,
      )
      .run(T0, T0, T0);

    database
      .prepare(
        `
          INSERT INTO marketplace_catalogue_items (
            id,
            marketplace,
            marketplace_catalogue_id,
            trade_unit_id,
            identity_class,
            mapping_version,
            mapping_status,
            evidence_ref,
            created_at,
            updated_at
          ) VALUES (
            'market-item-1',
            'SIM',
            'CAT-1',
            'trade-1',
            'A',
            1,
            'APPROVED',
            'fixture',
            ?,
            ?
          )
        `,
      )
      .run(T0, T0);

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
          ) VALUES (
            'listing-1',
            'SIM',
            'SELLER-1',
            'market-item-1',
            'offer-1',
            79900,
            1,
            79900,
            1,
            'ACTIVE',
            'ACTIVE',
            '1',
            1,
            ?
          )
        `,
      )
      .run(T0);

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
          ) VALUES (
            'SIM',
            'SELLER-1',
            79900,
            1,
            'ACTIVE',
            1,
            ?
          )
        `,
      )
      .run(T0);

    const result = invalidateTradeUnitMapping(
      database,
      "trade-1",
      "BARCODE_MISMATCH",
      "2026-10-07T00:10:00.000Z",
    );

    assert.deepEqual(result, {
      invalidatedMarketplaceMappings: 1,
      pausedListings: 1,
    });

    const trade = database
      .prepare(
        `
          SELECT mapping_status, invalidation_reason
          FROM packaged_trade_units
          WHERE id = 'trade-1'
        `,
      )
      .get() as {
      mapping_status: string;
      invalidation_reason: string;
    };
    const local = database
      .prepare(
        `
          SELECT desired_state, observed_state, observed_quantity
          FROM listings
          WHERE id = 'listing-1'
        `,
      )
      .get() as {
      desired_state: string;
      observed_state: string;
      observed_quantity: bigint;
    };
    const remote = database
      .prepare(
        `
          SELECT state, quantity
          FROM simulated_marketplace_listings
          WHERE marketplace = 'SIM'
            AND seller_sku = 'SELLER-1'
        `,
      )
      .get() as { state: string; quantity: bigint };

    assert.equal(trade.mapping_status, "INVALIDATED");
    assert.equal(trade.invalidation_reason, "BARCODE_MISMATCH");
    assert.equal(local.desired_state, "PAUSED");
    assert.equal(local.observed_state, "PAUSED");
    assert.equal(local.observed_quantity, 0n);
    assert.equal(remote.state, "PAUSED");
    assert.equal(remote.quantity, 0n);
  } finally {
    database.close();
  }
});
