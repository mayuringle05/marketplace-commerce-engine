import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyMigrations } from "./schema.ts";

export interface OpenDatabaseOptions {
  readonly appliedAt?: string;
}

function configureDatabase(
  database: DatabaseSync,
  fileBacked: boolean,
): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA synchronous = FULL");

  if (fileBacked) {
    database.exec("PRAGMA journal_mode = WAL");
  }
}

export function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  const fileBacked = path !== ":memory:";

  if (fileBacked) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    readBigInts: true,
    timeout: 5_000,
  });

  try {
    configureDatabase(database, fileBacked);
    applyMigrations(
      database,
      options.appliedAt ?? new Date().toISOString(),
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
