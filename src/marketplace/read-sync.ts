import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, deterministicId } from "../core/deterministic.ts";

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
  fetchPage(cursor: string | null): MarketplaceReadPage;
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

export function syncMarketplaceReadStream(
  database: DatabaseSync,
  marketplace: string,
  stream: string,
  source: MarketplaceReadSource,
  syncedAt: string,
): MarketplaceSyncResult {
  if (!source.approvedAccess) {
    throw new Error(
      "Marketplace read source is not approved for automated access.",
    );
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
  let inserted = 0;
  let duplicates = 0;

  database.exec("BEGIN IMMEDIATE");
  try {
    while (true) {
      const page = source.fetchPage(cursor);

      for (const event of page.events) {
        const id = deterministicId(
          "mpevent",
          marketplace,
          event.externalEventId,
        );
        const result = database
          .prepare(
            `
              INSERT OR IGNORE INTO marketplace_events (
                id,
                marketplace,
                event_type,
                external_event_id,
                payload_json,
                observed_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            id,
            marketplace,
            event.eventType,
            event.externalEventId,
            canonicalJson(event.payload),
            event.observedAt,
          );

        if (result.changes === 1n) {
          inserted += 1;
        } else {
          duplicates += 1;
        }
      }

      committedCheckpoint = page.checkpointCursor;
      cursor = page.nextCursor;

      if (page.nextCursor === null) {
        break;
      }
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

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return syncMarketplaceReadStream(
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
