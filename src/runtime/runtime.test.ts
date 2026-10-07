import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  acquireAccountLock,
  assertCurrentAccountLock,
} from "./account-lock.ts";
import {
  initializeRuntimeSafety,
  readRuntimeSafety,
  setStopNewExposure,
} from "./safety.ts";
import {
  completeJob,
  enqueueJob,
  leaseNextDueJob,
} from "../core/jobs.ts";
import {
  MarketplaceRateLimitError,
  syncMarketplaceReadStream,
  syncMarketplaceReadStreamWithRetry,
  type MarketplaceReadSource,
} from "../marketplace/read-sync.ts";
import {
  buildResearchPacket,
  importChatGptDecisionFile,
  writeResearchPacketFile,
} from "../research/chatgpt-handoff.ts";
import { seedSingleSkuFixture } from "../test/commerce-fixture.ts";

const T0 = "2026-10-07T00:00:00.000Z";

test("runtime starts fail-closed and requires explicit exposure enablement", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    initializeRuntimeSafety(database, T0);
    assert.deepEqual(readRuntimeSafety(database), {
      stopNewExposure: true,
      reason: "STARTUP_RECONCILIATION_REQUIRED",
    });

    setStopNewExposure(
      database,
      false,
      "OWNER_APPROVED_AFTER_RECONCILIATION",
      "2026-10-07T00:01:00.000Z",
    );

    assert.deepEqual(readRuntimeSafety(database), {
      stopNewExposure: false,
      reason: "OWNER_APPROVED_AFTER_RECONCILIATION",
    });
  } finally {
    database.close();
  }
});

test("expired job lease produces a new fencing token and rejects stale completion", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    enqueueJob(database, {
      jobType: "NOOP",
      subjectKey: "one",
      payload: { value: 1 },
      runAfter: T0,
      createdAt: T0,
    });

    const first = leaseNextDueJob(
      database,
      "worker-a",
      "2026-10-07T00:00:00.000Z",
      "2026-10-07T00:05:00.000Z",
    );
    assert.ok(first !== null);

    const second = leaseNextDueJob(
      database,
      "worker-b",
      "2026-10-07T00:06:00.000Z",
      "2026-10-07T00:11:00.000Z",
    );
    assert.ok(second !== null);
    assert.ok(second.fencingToken > first.fencingToken);

    assert.throws(
      () =>
        completeJob(
          database,
          first.id,
          "worker-a",
          first.fencingToken,
          "2026-10-07T00:06:30.000Z",
        ),
      /Stale or invalid job fencing token/,
    );

    completeJob(
      database,
      second.id,
      "worker-b",
      second.fencingToken,
      "2026-10-07T00:07:00.000Z",
    );
  } finally {
    database.close();
  }
});

test("account lock fencing rejects an expired owner after takeover", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const first = acquireAccountLock(
      database,
      "marketplace:SIM",
      "worker-a",
      T0,
      "2026-10-07T00:05:00.000Z",
    );

    const second = acquireAccountLock(
      database,
      "marketplace:SIM",
      "worker-b",
      "2026-10-07T00:06:00.000Z",
      "2026-10-07T00:11:00.000Z",
    );

    assert.ok(second.fencingToken > first.fencingToken);

    assert.throws(
      () =>
        assertCurrentAccountLock(
          database,
          first,
          "2026-10-07T00:06:30.000Z",
        ),
      /Stale account fencing token/,
    );

    assert.doesNotThrow(() =>
      assertCurrentAccountLock(
        database,
        second,
        "2026-10-07T00:07:00.000Z",
      ),
    );
  } finally {
    database.close();
  }
});

test("marketplace cursor advances only after every page succeeds", async () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    let call = 0;
    const source: MarketplaceReadSource = {
      approvedAccess: true,
      fetchPage(cursor) {
        call += 1;
        if (call === 1) {
          assert.equal(cursor, null);
          return {
            events: [
              {
                externalEventId: "evt-1",
                eventType: "ORDER",
                payload: { order: 1 },
                observedAt: T0,
              },
            ],
            nextCursor: "page-2",
            checkpointCursor: "checkpoint-1",
          };
        }

        if (call === 2) {
          assert.equal(cursor, "page-2");
          throw new Error("simulated rate limit");
        }

        throw new Error("unexpected page call");
      },
    };

    await assert.rejects(
      syncMarketplaceReadStream(
        database,
        "SIM",
        "orders",
        source,
        "2026-10-07T00:01:00.000Z",
      ),
      /simulated rate limit/,
    );

    const eventCount = database
      .prepare("SELECT COUNT(*) AS count FROM marketplace_events_v2")
      .get() as { count: bigint };
    const cursorCount = database
      .prepare("SELECT COUNT(*) AS count FROM marketplace_cursors")
      .get() as { count: bigint };

    assert.equal(eventCount.count, 0n);
    assert.equal(cursorCount.count, 0n);

    const success: MarketplaceReadSource = {
      approvedAccess: true,
      fetchPage(cursor) {
        if (cursor === null) {
          return {
            events: [
              {
                externalEventId: "evt-1",
                eventType: "ORDER",
                payload: { order: 1 },
                observedAt: T0,
              },
            ],
            nextCursor: "page-2",
            checkpointCursor: "checkpoint-1",
          };
        }

        return {
          events: [
            {
              externalEventId: "evt-1",
              eventType: "ORDER",
              payload: { order: 1 },
              observedAt: T0,
            },
            {
              externalEventId: "evt-2",
              eventType: "ORDER",
              payload: { order: 2 },
              observedAt: T0,
            },
          ],
          nextCursor: null,
          checkpointCursor: "checkpoint-2",
        };
      },
    };

    const result = await syncMarketplaceReadStream(
      database,
      "SIM",
      "orders",
      success,
      "2026-10-07T00:02:00.000Z",
    );

    assert.deepEqual(result, {
      inserted: 2,
      duplicates: 1,
      finalCursor: "checkpoint-2",
    });

    const cursor = database
      .prepare(
        `
          SELECT cursor
          FROM marketplace_cursors
          WHERE marketplace = 'SIM'
            AND stream = 'orders'
        `,
      )
      .get() as { cursor: string };

    assert.equal(cursor.cursor, "checkpoint-2");
  } finally {
    database.close();
  }
});

test("ChatGPT decision requires current exported packet provenance and remains unapproved", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const directory = mkdtempSync(join(tmpdir(), "cosmo-research-"));

  try {
    seedSingleSkuFixture(database);
    const packet = buildResearchPacket(
      database,
      "2026-10-07T00:13:00.000Z",
    );
    assert.equal(packet.opportunities.length, 1);

    const subjectId = packet.opportunities[0]?.id;
    assert.ok(subjectId !== undefined);

    const packetPath = join(directory, "packet.json");
    const inputHash = writeResearchPacketFile(
      database,
      packetPath,
      packet,
      "2026-10-07T01:00:00.000Z",
    );

    const rawPacket = readFileSync(packetPath, "utf8");
    assert.match(rawPacket, /"schemaVersion":1/);

    const decisionPath = join(directory, "decision.json");
    const decision = {
      schemaVersion: 1,
      decisionType: "RESEARCH_RECOMMENDATION",
      subjectId,
      inputHash,
      recommendation: "INVESTIGATE",
      rationale: "Check exact fees and supplier SLA before approval.",
    };
    writeFileSync(
      decisionPath,
      JSON.stringify(decision),
      "utf8",
    );

    const id = importChatGptDecisionFile(
      database,
      decisionPath,
      "2026-10-07T00:14:00.000Z",
    );

    const row = database
      .prepare(
        `
          SELECT approved_by_owner
          FROM chatgpt_decisions
          WHERE id = ?
        `,
      )
      .get(id) as { approved_by_owner: bigint };

    assert.equal(row.approved_by_owner, 0n);

    writeFileSync(
      decisionPath,
      JSON.stringify({
        ...decision,
        inputHash: "0".repeat(64),
      }),
      "utf8",
    );
    assert.throws(
      () =>
        importChatGptDecisionFile(
          database,
          decisionPath,
          "2026-10-07T00:14:00.000Z",
        ),
      /does not reference a current exported research packet/,
    );

    writeFileSync(
      decisionPath,
      JSON.stringify({
        ...decision,
        subjectId: "unknown-opportunity",
      }),
      "utf8",
    );
    assert.throws(
      () =>
        importChatGptDecisionFile(
          database,
          decisionPath,
          "2026-10-07T00:14:00.000Z",
        ),
      /subject was not present/,
    );

    writeFileSync(
      decisionPath,
      JSON.stringify({
        ...decision,
        refundPaise: 100_000,
      }),
      "utf8",
    );
    assert.throws(
      () =>
        importChatGptDecisionFile(
          database,
          decisionPath,
          "2026-10-07T00:14:00.000Z",
        ),
      /exact schema/,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("marketplace read rejects unapproved automated access", async () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const source: MarketplaceReadSource = {
      approvedAccess: false,
      fetchPage() {
        return {
          events: [],
          nextCursor: null,
          checkpointCursor: "never",
        };
      },
    };

    await assert.rejects(
      syncMarketplaceReadStream(
        database,
        "SIM",
        "orders",
        source,
        T0,
      ),
      /not approved for automated access/,
    );
  } finally {
    database.close();
  }
});

test("marketplace read honors Retry-After for safe reads", async () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const slept: number[] = [];
  let calls = 0;

  try {
    const source: MarketplaceReadSource = {
      approvedAccess: true,
      fetchPage() {
        calls += 1;
        if (calls === 1) {
          throw new MarketplaceRateLimitError(3);
        }

        return {
          events: [
            {
              externalEventId: "evt-retry-1",
              eventType: "ORDER",
              payload: { order: 1 },
              observedAt: T0,
            },
          ],
          nextCursor: null,
          checkpointCursor: "checkpoint-retry",
        };
      },
    };

    const result = await syncMarketplaceReadStreamWithRetry(
      database,
      "SIM",
      "orders",
      source,
      "2026-10-07T00:05:00.000Z",
      2,
      async (milliseconds) => {
        slept.push(milliseconds);
      },
    );

    assert.equal(calls, 2);
    assert.deepEqual(slept, [3_000]);
    assert.equal(result.inserted, 1);
    assert.equal(result.finalCursor, "checkpoint-retry");
  } finally {
    database.close();
  }
});

test("marketplace event identity is stream-scoped and conflicting replays fail", async () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const sourceFor = (
      eventType: string,
      payload: unknown,
      checkpoint: string,
    ): MarketplaceReadSource => ({
      approvedAccess: true,
      fetchPage() {
        return {
          events: [
            {
              externalEventId: "shared-id-1",
              eventType,
              payload,
              observedAt: T0,
            },
          ],
          nextCursor: null,
          checkpointCursor: checkpoint,
        };
      },
    });

    await syncMarketplaceReadStream(
      database,
      "SIM",
      "orders",
      sourceFor("ORDER", { order: 1 }, "orders-1"),
      "2026-10-07T00:10:00.000Z",
    );
    await syncMarketplaceReadStream(
      database,
      "SIM",
      "refunds",
      sourceFor("REFUND", { refund: 1 }, "refunds-1"),
      "2026-10-07T00:10:00.000Z",
    );

    const count = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM marketplace_events_v2
          WHERE external_event_id = 'shared-id-1'
        `,
      )
      .get() as { count: bigint };
    assert.equal(count.count, 2n);

    await assert.rejects(
      syncMarketplaceReadStream(
        database,
        "SIM",
        "orders",
        sourceFor("ORDER", { order: 999 }, "orders-2"),
        "2026-10-07T00:11:00.000Z",
      ),
      /Conflicting replay for marketplace event/,
    );

    const cursor = database
      .prepare(
        `
          SELECT cursor
          FROM marketplace_cursors
          WHERE marketplace = 'SIM'
            AND stream = 'orders'
        `,
      )
      .get() as { cursor: string };
    assert.equal(cursor.cursor, "orders-1");
  } finally {
    database.close();
  }
});

test("marketplace pagination cycles fail without advancing the cursor", async () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });

  try {
    const source: MarketplaceReadSource = {
      approvedAccess: true,
      fetchPage(cursor) {
        if (cursor === null) {
          return {
            events: [],
            nextCursor: "loop",
            checkpointCursor: "checkpoint-1",
          };
        }
        return {
          events: [],
          nextCursor: "loop",
          checkpointCursor: "checkpoint-2",
        };
      },
    };

    await assert.rejects(
      syncMarketplaceReadStream(
        database,
        "SIM",
        "orders",
        source,
        T0,
      ),
      /cursor cycle detected/,
    );

    const count = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM marketplace_cursors
        `,
      )
      .get() as { count: bigint };
    assert.equal(count.count, 0n);
  } finally {
    database.close();
  }
});
