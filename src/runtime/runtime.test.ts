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

test("marketplace cursor advances only after every page succeeds", () => {
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

    assert.throws(
      () =>
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
      .prepare("SELECT COUNT(*) AS count FROM marketplace_events")
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

    const result = syncMarketplaceReadStream(
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

test("ChatGPT handoff is file-based research only and imports unapproved", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T0,
  });
  const directory = mkdtempSync(join(tmpdir(), "cosmo-research-"));

  try {
    const packet = buildResearchPacket(
      database,
      "2026-10-07T00:03:00.000Z",
    );
    const packetPath = join(directory, "packet.json");
    const inputHash = writeResearchPacketFile(packetPath, packet);

    const rawPacket = readFileSync(packetPath, "utf8");
    assert.match(rawPacket, /"schemaVersion":1/);

    const decisionPath = join(directory, "decision.json");
    const decision = {
      schemaVersion: 1,
      decisionType: "RESEARCH_RECOMMENDATION",
      subjectId: "opportunity-demo",
      inputHash,
      recommendation: "INVESTIGATE",
      rationale: "Check exact fees and supplier SLA before approval.",
    };
    const json = JSON.stringify(decision);
    writeFileSync(decisionPath, json, "utf8");

    const id = importChatGptDecisionFile(
      database,
      decisionPath,
      "2026-10-07T00:04:00.000Z",
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
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("marketplace read rejects unapproved automated access", () => {
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

    assert.throws(
      () =>
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
