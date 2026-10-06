import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  enforceLiquidityGate,
  evaluateLiquidity,
} from "../cash/liquidity.ts";
import {
  ClassifiedFailure,
  canAutomaticallyRetry,
  classifyFailure,
} from "../core/failures.ts";
import {
  MarketplaceRateLimitError,
} from "../marketplace/read-sync.ts";
import {
  boundedBackoffSeconds,
  circuitBreakerOpen,
  monitoringCadenceSeconds,
} from "../monitoring/policy.ts";
import {
  aggregateDemandSignals,
  recordDemandSignal,
} from "../signals/demand.ts";
import {
  initializeRuntimeSafety,
  readRuntimeSafety,
  setStopNewExposure,
} from "../runtime/safety.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function seedExposure(
  database: ReturnType<typeof openDatabase>,
): void {
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
        ) VALUES (
          'order-1',
          'SIM',
          'REMOTE-1',
          'RESERVED',
          1,
          ?,
          ?,
          '{}'
        )
      `,
    )
    .run(T0, T0);

  database
    .prepare(
      `
        INSERT INTO reservations (
          id,
          order_id,
          source_offer_id,
          units,
          cash_paise,
          status,
          created_at,
          updated_at
        ) VALUES (
          'reservation-1',
          'order-1',
          'offer-1',
          1,
          50930,
          'ACTIVE',
          ?,
          ?
        )
      `,
    )
    .run(T0, T0);
}

test("liquidity gate includes committed cash, public exposure, and reserves", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    initializeRuntimeSafety(database, T0);
    setStopNewExposure(
      database,
      false,
      "TEST_READY",
      "2026-10-07T00:00:01.000Z",
    );
    seedExposure(database);

    const decision = evaluateLiquidity(database, {
      availableCashPaise: 100_000,
      refundReservePaise: 10_000,
      settlementDelayReservePaise: 20_000,
      evaluatedAt: "2026-10-07T00:05:00.000Z",
    });

    assert.equal(decision.committedCashPaise, 50_930n);
    assert.equal(decision.publicExposureCashPaise, 35_000n);
    assert.equal(decision.requiredCashPaise, 115_930n);
    assert.equal(decision.shortfallPaise, 15_930n);
    assert.equal(decision.passed, false);

    enforceLiquidityGate(database, {
      availableCashPaise: 100_000,
      refundReservePaise: 10_000,
      settlementDelayReservePaise: 20_000,
      evaluatedAt: "2026-10-07T00:05:00.000Z",
    });

    const safety = readRuntimeSafety(database);
    assert.equal(safety.stopNewExposure, true);
    assert.match(safety.reason, /LIQUIDITY_SHORTFALL/);

    const local = database
      .prepare(
        `
          SELECT observed_state, observed_quantity
          FROM listings
          WHERE id = 'listing-1'
        `,
      )
      .get() as {
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

    assert.equal(local.observed_state, "PAUSED");
    assert.equal(local.observed_quantity, 0n);
    assert.equal(remote.state, "PAUSED");
    assert.equal(remote.quantity, 0n);
  } finally {
    database.close();
  }
});

test("demand evidence aggregates reactive predictive and structural modes deterministically", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    recordDemandSignal(database, {
      subjectKey: "product-1",
      mode: "REACTIVE",
      sourceRef: "orders-a",
      score: 80,
      observedAt: "2026-10-07T00:01:00.000Z",
      evidence: { orders: 4 },
    });
    recordDemandSignal(database, {
      subjectKey: "product-1",
      mode: "REACTIVE",
      sourceRef: "orders-b",
      score: 100,
      observedAt: "2026-10-07T00:02:00.000Z",
      evidence: { orders: 8 },
    });
    recordDemandSignal(database, {
      subjectKey: "product-1",
      mode: "PREDICTIVE",
      sourceRef: "event-calendar",
      score: 70,
      observedAt: "2026-10-07T00:03:00.000Z",
      evidence: { event: "fixture" },
    });
    recordDemandSignal(database, {
      subjectKey: "product-1",
      mode: "STRUCTURAL",
      sourceRef: "supplier-history",
      score: 90,
      observedAt: "2026-10-07T00:04:00.000Z",
      evidence: { repeatAvailability: true },
    });

    assert.deepEqual(
      aggregateDemandSignals(
        database,
        "product-1",
        "2026-10-07T00:05:00.000Z",
        600,
      ),
      {
        reactive: 90,
        predictive: 70,
        structural: 90,
        evidenceCount: 4,
      },
    );

    assert.deepEqual(
      aggregateDemandSignals(
        database,
        "product-1",
        "2026-10-07T01:00:00.000Z",
        60,
      ),
      {
        reactive: 0,
        predictive: 0,
        structural: 0,
        evidenceCount: 0,
      },
    );
  } finally {
    database.close();
  }
});

test("monitoring cadence, backoff, and circuit breaker are bounded", () => {
  assert.equal(
    monitoringCadenceSeconds("ORDER_OR_QUOTE_CRITICAL"),
    0,
  );
  assert.equal(
    monitoringCadenceSeconds("ACTIVE_VOLATILE"),
    300,
  );
  assert.equal(
    monitoringCadenceSeconds("ACTIVE_NORMAL"),
    900,
  );
  assert.equal(
    monitoringCadenceSeconds("STABLE_LOCKED"),
    1_800,
  );
  assert.equal(
    monitoringCadenceSeconds("WATCHLIST"),
    14_400,
  );
  assert.equal(
    monitoringCadenceSeconds("DISCOVERY"),
    86_400,
  );
  assert.equal(
    monitoringCadenceSeconds("SEASONAL_FAR"),
    604_800,
  );

  assert.equal(boundedBackoffSeconds(1), 5);
  assert.equal(boundedBackoffSeconds(4), 40);
  assert.equal(boundedBackoffSeconds(20), 3_600);
  assert.equal(boundedBackoffSeconds(1, 120), 120);
  assert.equal(boundedBackoffSeconds(1, 10_000), 3_600);

  assert.equal(
    circuitBreakerOpen({
      consecutiveFailures: 4,
      unresolvedOperationalExceptions: 2,
    }),
    false,
  );
  assert.equal(
    circuitBreakerOpen({
      consecutiveFailures: 5,
      unresolvedOperationalExceptions: 0,
    }),
    true,
  );
  assert.equal(
    circuitBreakerOpen({
      consecutiveFailures: 0,
      unresolvedOperationalExceptions: 3,
    }),
    true,
  );
});

test("only safe reads and rate limits are automatically retryable", () => {
  assert.equal(
    classifyFailure(new MarketplaceRateLimitError(5)),
    "RATE_LIMIT",
  );
  assert.equal(
    classifyFailure(
      new ClassifiedFailure(
        "UNKNOWN_SIDE_EFFECT",
        "purchase response lost",
      ),
    ),
    "UNKNOWN_SIDE_EFFECT",
  );

  assert.equal(canAutomaticallyRetry("SAFE_READ_RETRY"), true);
  assert.equal(canAutomaticallyRetry("RATE_LIMIT"), true);
  assert.equal(canAutomaticallyRetry("AUTH_REQUIRED"), false);
  assert.equal(canAutomaticallyRetry("EXPLICIT_REJECTION"), false);
  assert.equal(canAutomaticallyRetry("UNKNOWN_SIDE_EFFECT"), false);
  assert.equal(canAutomaticallyRetry("VALIDATION_FAILURE"), false);
  assert.equal(canAutomaticallyRetry("POLICY_BLOCK"), false);
});
