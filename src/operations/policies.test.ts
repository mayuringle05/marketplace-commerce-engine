import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  enforceLiquidityGate,
  evaluateLiquidity,
} from "../cash/liquidity.ts";
import {
  recordVerifiedCashSnapshot,
  setCashReservePolicy,
} from "../cash/state.ts";
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
  readRuntimeSafety,
} from "../runtime/safety.ts";
import {
  authorizeSingleOrder,
  ingestSingleOrder,
  seedSingleSkuFixture,
} from "../test/commerce-fixture.ts";

const T0 = "2026-10-07T00:00:00.000Z";

test("liquidity gate covers reservations, public peak cash, and reserves from verified balance", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const fixture = seedSingleSkuFixture(database, {
      cashPaise: 250_000,
      listingQuantity: 2,
    });
    const orderId = ingestSingleOrder(database, "LIQUIDITY");
    authorizeSingleOrder(
      database,
      orderId,
      fixture.sourceOfferId,
    );

    setCashReservePolicy(
      database,
      10_000,
      20_000,
      "2026-10-07T00:12:40.000Z",
    );
    recordVerifiedCashSnapshot(
      database,
      100_000,
      "lower-bank-balance",
      "2026-10-07T00:12:45.000Z",
      "2026-10-07T00:30:00.000Z",
    );

    const decision = evaluateLiquidity(database, {
      evaluatedAt: "2026-10-07T00:13:00.000Z",
    });

    assert.equal(
      decision.committedCashPaise,
      BigInt(fixture.peakCashPaise),
    );
    assert.equal(
      decision.publicExposureCashPaise,
      BigInt(fixture.peakCashPaise),
    );
    assert.equal(decision.refundReservePaise, 10_000n);
    assert.equal(
      decision.settlementDelayReservePaise,
      20_000n,
    );
    assert.equal(
      decision.requiredCashPaise,
      BigInt(fixture.peakCashPaise * 2 + 30_000),
    );
    assert.equal(decision.availableCashPaise, 100_000n);
    assert.ok(decision.shortfallPaise > 0n);
    assert.equal(decision.passed, false);

    enforceLiquidityGate(database, {
      evaluatedAt: "2026-10-07T00:13:00.000Z",
    });

    const safety = readRuntimeSafety(database);
    assert.equal(safety.stopNewExposure, true);
    assert.match(safety.reason, /LIQUIDITY_SHORTFALL/);

    const listing = database
      .prepare(
        `
          SELECT observed_state, observed_quantity
          FROM listings
          WHERE id = ?
        `,
      )
      .get(fixture.listingId) as {
      observed_state: string;
      observed_quantity: bigint;
    };

    assert.equal(listing.observed_state, "PAUSED");
    assert.equal(listing.observed_quantity, 0n);
  } finally {
    database.close();
  }
});

test("stale cash evidence blocks liquidity evaluation", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    seedSingleSkuFixture(database);

    assert.throws(
      () =>
        evaluateLiquidity(database, {
          evaluatedAt: "2026-10-07T01:00:00.000Z",
        }),
      /No current verified cash snapshot/,
    );
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

test("monitoring cadence, backoff, and circuit breaker are bounded without shortening Retry-After", () => {
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
  assert.equal(boundedBackoffSeconds(1, 10_000), 10_000);

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
