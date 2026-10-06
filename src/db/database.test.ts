import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.ts";
import { applyMigrations } from "./schema.ts";

const TEST_TIMESTAMP = "2026-10-06T18:30:00.000Z";

function insertMinimumCatalogue(database: ReturnType<typeof openDatabase>) {
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "product-1",
      "Example Brand",
      "Example Manufacturer",
      "Model 1",
      "MPN-1",
      "new",
      "IN",
      TEST_TIMESTAMP,
      TEST_TIMESTAMP,
    );

  database
    .prepare(
      `
        INSERT INTO suppliers (
          id,
          legal_name,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      "supplier-1",
      "Example Distributor Pvt Ltd",
      "verified",
      TEST_TIMESTAMP,
      TEST_TIMESTAMP,
    );
}

test("applies each V1a migration exactly once", () => {
  const database = openDatabase(":memory:", {
    appliedAt: TEST_TIMESTAMP,
  });

  try {
    applyMigrations(database, TEST_TIMESTAMP);

    const row = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: bigint };

    assert.equal(row.count, 4n);
  } finally {
    database.close();
  }
});

test("enables foreign-key enforcement", () => {
  const database = openDatabase(":memory:", {
    appliedAt: TEST_TIMESTAMP,
  });

  try {
    const row = database
      .prepare("PRAGMA foreign_keys")
      .get() as { foreign_keys: bigint };

    assert.equal(row.foreign_keys, 1n);

    assert.throws(
      () =>
        database
          .prepare(
            `
              INSERT INTO product_identifiers (
                product_id,
                identifier_type,
                normalized_value,
                evidence_class,
                source_ref,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            "missing-product",
            "GTIN13",
            "8901234567890",
            "A",
            "test",
            TEST_TIMESTAMP,
          ),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("uses WAL for the local file-backed database", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "cosmo-commerce-sqlite-"),
  );
  const path = join(directory, "commerce.sqlite");
  const database = openDatabase(path, {
    appliedAt: TEST_TIMESTAMP,
  });

  try {
    const row = database
      .prepare("PRAGMA journal_mode")
      .get() as { journal_mode: string };

    assert.equal(row.journal_mode.toLowerCase(), "wal");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects duplicate canonical identifiers", () => {
  const database = openDatabase(":memory:", {
    appliedAt: TEST_TIMESTAMP,
  });

  try {
    insertMinimumCatalogue(database);

    const statement = database.prepare(
      `
        INSERT INTO product_identifiers (
          product_id,
          identifier_type,
          normalized_value,
          evidence_class,
          source_ref,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    );

    statement.run(
      "product-1",
      "GTIN13",
      "8901234567890",
      "A",
      "supplier-catalogue-v1",
      TEST_TIMESTAMP,
    );

    assert.throws(
      () =>
        statement.run(
          "product-1",
          "GTIN13",
          "8901234567890",
          "A",
          "duplicate-source",
          TEST_TIMESTAMP,
        ),
      /UNIQUE constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("rejects invalid source-offer money and allocation states", () => {
  const database = openDatabase(":memory:", {
    appliedAt: TEST_TIMESTAMP,
  });

  try {
    insertMinimumCatalogue(database);

    const insertOffer = database.prepare(
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    assert.throws(
      () =>
        insertOffer.run(
          "offer-negative-cost",
          "supplier-1",
          "product-1",
          "SKU-1",
          -1,
          1_800,
          5,
          5,
          "2026-10-06T00:00:00.000Z",
          "2026-10-07T00:00:00.000Z",
          TEST_TIMESTAMP,
          "quote-v1",
          "supplier-file",
        ),
      /CHECK constraint failed/,
    );

    assert.throws(
      () =>
        insertOffer.run(
          "offer-overallocated",
          "supplier-1",
          "product-1",
          "SKU-1",
          35_000,
          1_800,
          5,
          6,
          "2026-10-06T00:00:00.000Z",
          "2026-10-07T00:00:00.000Z",
          TEST_TIMESTAMP,
          "quote-v1",
          "supplier-file",
        ),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("persists exact integer paise and allocation values", () => {
  const database = openDatabase(":memory:", {
    appliedAt: TEST_TIMESTAMP,
  });

  try {
    insertMinimumCatalogue(database);

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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "offer-1",
        "supplier-1",
        "product-1",
        "SKU-1",
        35_001,
        1_800,
        5,
        3,
        "2026-10-06T00:00:00.000Z",
        "2026-10-07T00:00:00.000Z",
        TEST_TIMESTAMP,
        "quote-v1",
        "supplier-file",
      );

    const row = database
      .prepare(
        `
          SELECT
            gross_cost_paise,
            tax_rate_bps,
            allocated_units,
            available_units
          FROM source_offers
          WHERE id = ?
        `,
      )
      .get("offer-1") as {
        gross_cost_paise: bigint;
        tax_rate_bps: bigint;
        allocated_units: bigint;
        available_units: bigint;
      };

    assert.equal(row.gross_cost_paise, 35_001n);
    assert.equal(row.tax_rate_bps, 1_800n);
    assert.equal(row.allocated_units, 5n);
    assert.equal(row.available_units, 3n);
  } finally {
    database.close();
  }
});
