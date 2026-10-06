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
  {
    version: 4,
    name: "local_e2e_operational_state",
    sql: `
      CREATE TABLE packaged_trade_units (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL
          REFERENCES products(id) ON DELETE RESTRICT,
        variant TEXT,
        edition TEXT,
        pack_count INTEGER NOT NULL CHECK (pack_count > 0),
        condition TEXT NOT NULL CHECK (condition = 'new'),
        market_region TEXT NOT NULL,
        barcode_type TEXT CHECK (
          barcode_type IS NULL OR barcode_type IN (
            'GTIN8',
            'GTIN12',
            'GTIN13',
            'GTIN14',
            'ISBN10',
            'ISBN13'
          )
        ),
        barcode_value TEXT,
        mapping_version INTEGER NOT NULL CHECK (mapping_version > 0),
        mapping_status TEXT NOT NULL CHECK (
          mapping_status IN ('APPROVED', 'WATCH', 'INVALIDATED')
        ),
        invalidation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (barcode_type IS NULL AND barcode_value IS NULL) OR
          (barcode_type IS NOT NULL AND barcode_value IS NOT NULL)
        ),
        UNIQUE (product_id, market_region, pack_count, mapping_version)
      ) STRICT;

      CREATE TABLE marketplace_catalogue_items (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        marketplace_catalogue_id TEXT NOT NULL,
        trade_unit_id TEXT NOT NULL
          REFERENCES packaged_trade_units(id) ON DELETE RESTRICT,
        identity_class TEXT NOT NULL CHECK (
          identity_class IN ('A', 'B', 'C', 'D', 'CONFLICT')
        ),
        mapping_version INTEGER NOT NULL CHECK (mapping_version > 0),
        mapping_status TEXT NOT NULL CHECK (
          mapping_status IN ('APPROVED', 'WATCH', 'INVALIDATED')
        ),
        evidence_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (marketplace, marketplace_catalogue_id),
        UNIQUE (marketplace, trade_unit_id, mapping_version)
      ) STRICT;

      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        seller_sku TEXT NOT NULL,
        marketplace_catalogue_item_id TEXT NOT NULL
          REFERENCES marketplace_catalogue_items(id) ON DELETE RESTRICT,
        source_offer_id TEXT NOT NULL
          REFERENCES source_offers(id) ON DELETE RESTRICT,
        desired_price_paise INTEGER NOT NULL CHECK (desired_price_paise >= 0),
        desired_quantity INTEGER NOT NULL CHECK (desired_quantity >= 0),
        observed_price_paise INTEGER CHECK (observed_price_paise >= 0),
        observed_quantity INTEGER CHECK (observed_quantity >= 0),
        desired_state TEXT NOT NULL CHECK (
          desired_state IN ('ACTIVE', 'PAUSED')
        ),
        observed_state TEXT NOT NULL CHECK (
          observed_state IN ('UNKNOWN', 'ACTIVE', 'PAUSED')
        ),
        remote_version TEXT,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at TEXT NOT NULL,
        UNIQUE (marketplace, seller_sku)
      ) STRICT;

      CREATE TABLE opportunities (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL
          REFERENCES products(id) ON DELETE RESTRICT,
        trade_unit_id TEXT NOT NULL
          REFERENCES packaged_trade_units(id) ON DELETE RESTRICT,
        source_offer_id TEXT NOT NULL
          REFERENCES source_offers(id) ON DELETE RESTRICT,
        marketplace TEXT NOT NULL,
        decision_state TEXT NOT NULL CHECK (
          decision_state IN ('LIST', 'WATCH', 'REJECT')
        ),
        hard_gates_passed INTEGER NOT NULL CHECK (
          hard_gates_passed IN (0, 1)
        ),
        opportunity_score INTEGER NOT NULL CHECK (
          opportunity_score >= 0 AND opportunity_score <= 100
        ),
        demand_score INTEGER NOT NULL CHECK (
          demand_score >= 0 AND demand_score <= 100
        ),
        decision_profit_paise INTEGER NOT NULL,
        blocking_reasons_json TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (
          trade_unit_id,
          source_offer_id,
          marketplace,
          evidence_version
        )
      ) STRICT;

      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        marketplace_order_id TEXT NOT NULL,
        state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        received_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        immutable_economics_json TEXT NOT NULL,
        UNIQUE (marketplace, marketplace_order_id)
      ) STRICT;

      CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL
          REFERENCES orders(id) ON DELETE CASCADE,
        listing_id TEXT NOT NULL
          REFERENCES listings(id) ON DELETE RESTRICT,
        trade_unit_id TEXT NOT NULL
          REFERENCES packaged_trade_units(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        accepted_price_paise INTEGER NOT NULL CHECK (
          accepted_price_paise >= 0
        ),
        UNIQUE (order_id, listing_id)
      ) STRICT;

      CREATE TABLE reservations (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL
          REFERENCES orders(id) ON DELETE CASCADE,
        source_offer_id TEXT NOT NULL
          REFERENCES source_offers(id) ON DELETE RESTRICT,
        units INTEGER NOT NULL CHECK (units > 0),
        cash_paise INTEGER NOT NULL CHECK (cash_paise >= 0),
        status TEXT NOT NULL CHECK (
          status IN ('ACTIVE', 'RELEASED', 'CONSUMED')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (order_id, source_offer_id)
      ) STRICT;

      CREATE TABLE purchase_orders (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL UNIQUE
          REFERENCES orders(id) ON DELETE RESTRICT,
        supplier_id TEXT NOT NULL
          REFERENCES suppliers(id) ON DELETE RESTRICT,
        client_po_ref TEXT NOT NULL UNIQUE,
        provider_po_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN (
            'INTENT_RECORDED',
            'SUBMITTING',
            'CONFIRMED',
            'REJECTED',
            'PURCHASE_UNKNOWN'
          )
        ),
        authorized_amount_paise INTEGER NOT NULL CHECK (
          authorized_amount_paise >= 0
        ),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        payload_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE shipments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL
          REFERENCES orders(id) ON DELETE RESTRICT,
        purchase_order_id TEXT NOT NULL
          REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        carrier TEXT NOT NULL,
        tracking_number TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'PACK_CONFIRMED',
            'HANDOVER_CONFIRMED',
            'IN_TRANSIT',
            'DELIVERED',
            'RTO',
            'LOST',
            'DAMAGED'
          )
        ),
        label_ref TEXT NOT NULL,
        handover_evidence_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (carrier, tracking_number),
        UNIQUE (order_id)
      ) STRICT;

      CREATE TABLE returns (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL
          REFERENCES orders(id) ON DELETE RESTRICT,
        marketplace_return_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN (
            'OPEN',
            'IN_TRANSIT',
            'RECEIVED',
            'GRADED',
            'CREDIT_PENDING',
            'CLOSED'
          )
        ),
        refund_paise INTEGER NOT NULL CHECK (refund_paise >= 0),
        recovery_paise INTEGER NOT NULL CHECK (recovery_paise >= 0),
        grade TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY,
        order_id TEXT
          REFERENCES orders(id) ON DELETE RESTRICT,
        external_event_id TEXT,
        entry_type TEXT NOT NULL CHECK (
          entry_type IN (
            'CUSTOMER_REVENUE',
            'MARKETPLACE_FEE',
            'LOGISTICS',
            'SUPPLIER_PAYABLE',
            'PACKING',
            'TAX_OUTPUT',
            'TAX_INPUT_CREDIT',
            'WITHHOLDING_ASSET',
            'REFUND',
            'RETURN_RECOVERY',
            'SETTLEMENT',
            'ADJUSTMENT'
          )
        ),
        amount_paise INTEGER NOT NULL,
        recognized INTEGER NOT NULL CHECK (recognized IN (0, 1)),
        provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
        source_ref TEXT NOT NULL,
        event_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (external_event_id, entry_type)
      ) STRICT;

      CREATE INDEX ledger_entries_order_idx
        ON ledger_entries(order_id, event_at);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'PENDING',
            'LEASED',
            'SUCCEEDED',
            'FAILED',
            'QUARANTINED'
          )
        ),
        run_after TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX jobs_due_idx
        ON jobs(status, run_after);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX audit_events_subject_idx
        ON audit_events(subject_type, subject_id, occurred_at);

      CREATE TABLE exceptions (
        id TEXT PRIMARY KEY,
        order_id TEXT
          REFERENCES orders(id) ON DELETE RESTRICT,
        exception_type TEXT NOT NULL,
        owner TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        safe_next_action TEXT NOT NULL,
        exposure_reserved INTEGER NOT NULL CHECK (
          exposure_reserved IN (0, 1)
        ),
        state TEXT NOT NULL CHECK (
          state IN ('OPEN', 'RESOLVED')
        ),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;

      CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        rule_key TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL CHECK (version > 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE signals_events (
        id TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (signal_type, subject_key, source_ref, observed_at)
      ) STRICT;

      CREATE TABLE action_intents (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        account_scope TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'RECORDED',
            'SUBMITTING',
            'SUCCEEDED',
            'REJECTED',
            'UNKNOWN_SIDE_EFFECT',
            'QUARANTINED'
          )
        ),
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
        provider_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (action_type, account_scope, subject_id, payload_hash)
      ) STRICT;

      CREATE TABLE chatgpt_decisions (
        id TEXT PRIMARY KEY,
        decision_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        input_hash TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        approved_by_owner INTEGER NOT NULL CHECK (
          approved_by_owner IN (0, 1)
        ),
        imported_at TEXT NOT NULL,
        UNIQUE (decision_type, subject_id, input_hash)
      ) STRICT;

      CREATE TABLE simulated_marketplace_listings (
        marketplace TEXT NOT NULL,
        seller_sku TEXT NOT NULL,
        price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
        quantity INTEGER NOT NULL CHECK (quantity >= 0),
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'PAUSED')),
        remote_version INTEGER NOT NULL CHECK (remote_version > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (marketplace, seller_sku)
      ) STRICT;

      CREATE TABLE simulated_supplier_orders (
        idempotency_key TEXT PRIMARY KEY,
        provider_po_id TEXT NOT NULL UNIQUE,
        client_po_ref TEXT NOT NULL UNIQUE,
        amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        state TEXT NOT NULL CHECK (
          state IN ('CONFIRMED', 'REJECTED')
        ),
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: "local_runtime_cursors_and_locks",
    sql: `
      CREATE TABLE marketplace_cursors (
        marketplace TEXT NOT NULL,
        stream TEXT NOT NULL,
        cursor TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (marketplace, stream)
      ) STRICT;

      CREATE TABLE marketplace_events (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        event_type TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (marketplace, external_event_id)
      ) STRICT;

      CREATE TABLE runtime_state (
        state_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE account_locks (
        account_scope TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        lease_until TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "v1_exposure_and_spend_authorization",
    sql: `
      CREATE UNIQUE INDEX listings_single_source_pool_idx
        ON listings(source_offer_id);

      ALTER TABLE purchase_orders
        ADD COLUMN authorization_expires_at TEXT;
    `,
  },
  {
    version: 7,
    name: "physical_identity_verification",
    sql: `
      ALTER TABLE packaged_trade_units
        ADD COLUMN physical_verified_at TEXT;
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
