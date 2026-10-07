import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openDatabase } from "../db/database.ts";
import { createVerifiedEncryptedBackup } from "../runtime/backup.ts";
import { readMacKeychainSecret } from "../runtime/macos-keychain.ts";
import { canonicalJson } from "../core/deterministic.ts";

const dbPath = process.argv[2] ?? "data/commerce.sqlite";
const outputPath =
  process.argv[3] ?? "backups/commerce.sqlite.enc";

mkdirSync(dirname(outputPath), { recursive: true });

const keyHex =
  process.env.COSMO_BACKUP_KEY_HEX ??
  readMacKeychainSecret("cosmo-commerce", "backup-key");

const database = openDatabase(dbPath, {
  appliedAt: new Date().toISOString(),
});

try {
  createVerifiedEncryptedBackup(
    dbPath,
    database,
    outputPath,
    keyHex,
  );
  process.stdout.write(
    `${canonicalJson({
      database: dbPath,
      encryptedBackup: outputPath,
      integrity: "ok",
    })}\n`,
  );
} finally {
  database.close();
}
