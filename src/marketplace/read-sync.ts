import type { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  deterministicId,
  sha256Hex,
} from "../core/deterministic.ts";

export interface MarketplaceReadEvent {
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly observedAt: string;
}

export interface MarketplaceReadPage {
  readonly events: readonly MarketplaceReadEvent[];
  readonly nextCursor: string | null;
  readonly checkpointCursor: string;
}

export interface MarketplaceReadSource {
  readonly approvedAccess: boolean;
  fetchPage(
    cursor: string | null,
  ): MarketplaceReadPage | Promise<MarketplaceReadPage>;
}

export class MarketplaceRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Marketplace rate limit reached.");
    if (
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 0
    ) {
      throw new Error(
        "retryAfterSeconds must be a non-negative integer.",
      );
    }
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface MarketplaceSyncResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly finalCursor: string | null;
}

interface BufferedEvent {
  readonly event: MarketplaceReadEvent;
  readonly payloadJson: string;
  readonly payloadHash: string;
}

export async function syncMarketplaceReadStream(
  database: DatabaseSync,
  marketplace: string,
  stream: string,
  source: MarketplaceReadSource,
  syncedAt: string,
  maximumPages = 100,
): Promise<MarketplaceSyncResult> {
  if (!source.approvedAccess) {
    throw new Error(
      "Marketplace read source is not approved for automated access.",
    );
  }
  if (
    !Number.isSafeInteger(maximumPages) ||
    maximumPages < 1 ||
    maximumPages > 1_000
  ) {
    throw new Error("maximumPages must be 1..1000.");
  }

  const cursorRow = database
    .prepare(
      `
        SELECT cursor
        FROM marketplace_cursors
        WHERE marketplace = ?
          AND stream = ?
      `,
    )
    .get(marketplace, stream) as
    | { cursor: string | null }
    | undefined;

  const initialCursor = cursorRow?.cursor ?? null;
  let cursor = initialCursor;
  let committedCheckpoint = initialCursor;
  const seenPageCursors = new Set<string>();
  const buffered: BufferedEvent[] = [];

  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    const cursorKey = cursor ?? "<NULL>";
    if (seenPageCursors.has(cursorKey)) {
      throw new Error("Marketplace pagination cursor cycle detected.");
    }
    seenPageCursors.add(cursorKey);

    const page = await source.fetchPage(cursor);
    if (page.checkpointCursor.trim().length === 0) {
      throw new Error("Marketplace checkpoint cursor is required.");
    }

    for (const event of page.events) {
      const payloadJson = canonicalJson(event.payload);
      buffered.push({
        event,
        payloadJson,
        payloadHash: sha256Hex(payloadJson),
      });
    }

    committedCheckpoint = page.checkpointCursor;
    cursor = page.nextCursor;

    if (cursor === null) {
      break;
    }

    if (pageIndex === maximumPages - 1) {
      throw new Error("Marketplace pagination exceeded page limit.");
    }
  }

  let inserted = 0;
  let duplicates = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare(
        `
          SELECT cursor
          FROM marketplace_cursors
          WHERE marketplace = ?
            AND stream = ?
        `,
      )
      .get(marketplace, stream) as
      | { cursor: string | null }
      | undefined;

    if ((current?.cursor ?? null) !== initialCursor) {
      throw new Error(
        "Marketplace cursor changed during fetch; retry from the new checkpoint.",
      );
    }

    for (const item of buffered) {
      const id = deterministicId(
        "mpevent",
        marketplace,
        stream,
        item.event.externalEventId,
      );

      const existing = database
        .prepare(
          `
            SELECT payload_hash
            FROM marketplace_events_v2
            WHERE marketplace = ?
              AND stream = ?
              AND external_event_id = ?
          `,
        )
        .get(
          marketplace,
          stream,
          item.event.externalEventId,
        ) as { payload_hash: string } | undefined;

      if (existing !== undefined) {
        if (existing.payload_hash !== item.payloadHash) {
          throw new Error(
            "Conflicting replay for marketplace event.",
          );
        }
        duplicates += 1;
        continue;
      }

      database
        .prepare(
          `
            INSERT INTO marketplace_events_v2 (
              id,
              marketplace,
              stream,
              event_type,
              external_event_id,
              payload_json,
              payload_hash,
              observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          marketplace,
          stream,
          item.event.eventType,
          item.event.externalEventId,
          item.payloadJson,
          item.payloadHash,
          item.event.observedAt,
        );
      inserted += 1;
    }

    database
      .prepare(
        `
          INSERT INTO marketplace_cursors (
            marketplace,
            stream,
            cursor,
            updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(marketplace, stream) DO UPDATE SET
            cursor = excluded.cursor,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        marketplace,
        stream,
        committedCheckpoint,
        syncedAt,
      );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    inserted,
    duplicates,
    finalCursor: committedCheckpoint,
  };
}

export async function syncMarketplaceReadStreamWithRetry(
  database: DatabaseSync,
  marketplace: string,
  stream: string,
  source: MarketplaceReadSource,
  syncedAt: string,
  maximumAttempts: number,
  sleeper: (milliseconds: number) => Promise<void>,
): Promise<MarketplaceSyncResult> {
  if (
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts < 1 ||
    maximumAttempts > 10
  ) {
    throw new Error("maximumAttempts must be 1..10.");
  }

  for (
    let attempt = 1;
    attempt <= maximumAttempts;
    attempt += 1
  ) {
    try {
      return await syncMarketplaceReadStream(
        database,
        marketplace,
        stream,
        source,
        syncedAt,
      );
    } catch (error) {
      if (
        !(error instanceof MarketplaceRateLimitError) ||
        attempt === maximumAttempts
      ) {
        throw error;
      }

      await sleeper(error.retryAfterSeconds * 1_000);
    }
  }

  throw new Error("Marketplace read retry loop exhausted.");
}
