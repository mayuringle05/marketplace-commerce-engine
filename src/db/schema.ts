import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "v1a_core_catalogue_and_supply",
    sql: `
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        brand TEXT NOT NULL,
        manufacturer TEXT,
        model TEXT,
        mpn TEXT,
        condition TEXT NOT NULL CHECK (condition = 'new'),
        market_region TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE product_identifiers (
        id INTEGER PRIMARY KEY,
        product_id TEXT NOT NULL
          REFERENCES products(id) ON DELETE CASCADE,
        identifier_type TEXT NOT NULL CHECK (
          identifier_type IN (
            'GTIN8',
            'GTIN12',
            'GTIN13',
            'GTIN14',
            'ISBN10',
            'ISBN13',
            'MPN'
          )
        ),
        normalized_value TEXT NOT NULL,
        evidence_class TEXT NOT NULL CHECK (
          evidence_class IN ('A', 'B', 'C', 'D', 'CONFLICT')
        ),
        source_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (identifier_type, normalized_value)
      ) STRICT;

      CREATE INDEX product_identifiers_product_idx
        ON product_identifiers(product_id);

      CREATE TABLE suppliers (
        id TEXT PRIMARY KEY,
        legal_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('candidate', 'verified', 'suspended', 'rejected')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE fulfilment_routes (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL
          REFERENCES suppliers(id) ON DELETE RESTRICT,
        dispatch_country TEXT NOT NULL,
        dispatch_region TEXT NOT NULL,
        single_unit_dispatch_verified INTEGER NOT NULL
          CHECK (single_unit_dispatch_verified IN (0, 1)),
        return_route_verified INTEGER NOT NULL
          CHECK (return_route_verified IN (0, 1)),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX fulfilment_routes_supplier_idx
        ON fulfilment_routes(supplier_id);

      CREATE TABLE source_offers (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL
          REFERENCES suppliers(id) ON DELETE RESTRICT,
        product_id TEXT NOT NULL
          REFERENCES products(id) ON DELETE RESTRICT,
        supplier_sku TEXT NOT NULL,
        gross_cost_paise INTEGER NOT NULL
          CHECK (gross_cost_paise >= 0),
        tax_rate_bps INTEGER NOT NULL
          CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 100000),
        allocated_units INTEGER NOT NULL
          CHECK (allocated_units >= 0),
        available_units INTEGER NOT NULL
          CHECK (available_units >= 0),
        valid_from TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source_version TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        CHECK (available_units <= allocated_units),
        CHECK (valid_until > valid_from),
        UNIQUE (
          supplier_id,
          supplier_sku,
          source_version,
          observed_at
        )
      ) STRICT;

      CREATE INDEX source_offers_product_idx
        ON source_offers(product_id);

      CREATE INDEX source_offers_supplier_sku_idx
        ON source_offers(supplier_id, supplier_sku);

      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL CHECK (
          subject_type IN (
            'product',
            'supplier',
            'source_offer',
            'fulfilment_route'
          )
        ),
        subject_id TEXT NOT NULL,
        observation_type TEXT NOT NULL,
        value_text TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (
          subject_type,
          subject_id,
          observation_type,
          evidence_hash
        )
      ) STRICT;

      CREATE INDEX observations_subject_idx
        ON observations(subject_type, subject_id, observed_at);
    `,
  },
  {
    version: 2,
    name: "v1a_supplier_offer_package_and_route",
    sql: `
      ALTER TABLE source_offers
        ADD COLUMN fulfilment_route_id TEXT
          REFERENCES fulfilment_routes(id) ON DELETE RESTRICT;

      ALTER TABLE source_offers
        ADD COLUMN packed_weight_grams INTEGER
          CHECK (
            packed_weight_grams IS NULL OR packed_weight_grams > 0
          );

      ALTER TABLE source_offers
        ADD COLUMN package_length_mm INTEGER
          CHECK (
            package_length_mm IS NULL OR package_length_mm > 0
          );

      ALTER TABLE source_offers
        ADD COLUMN package_width_mm INTEGER
          CHECK (
            package_width_mm IS NULL OR package_width_mm > 0
          );

      ALTER TABLE source_offers
        ADD COLUMN package_height_mm INTEGER
          CHECK (
            package_height_mm IS NULL OR package_height_mm > 0
          );

      CREATE INDEX source_offers_route_idx
        ON source_offers(fulfilment_route_id);
    `,
  },
  {
    version: 3,
    name: "v1a_unambiguous_supplier_observation_time",
    sql: `
      CREATE UNIQUE INDEX source_offers_observation_identity_idx
        ON source_offers(
          supplier_id,
          supplier_sku,
          observed_at
        );
    `,
  },
];

export function applyMigrations(
  database: DatabaseSync,
  appliedAt: string,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: bigint }>;

  const applied = new Set(
    appliedRows.map((row) => Number(row.version)),
  );

  const insertMigration = database.prepare(
    `
      INSERT INTO schema_migrations (
        version,
        name,
        applied_at
      ) VALUES (?, ?, ?)
    `,
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insertMigration.run(
        migration.version,
        migration.name,
        appliedAt,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
