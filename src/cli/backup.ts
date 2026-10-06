import { rmSync } from "node:fs";

import { openDatabase } from "../db/database.ts";
import {
  createConsistentSqliteBackup,
  decryptBackupFile,
  encryptBackupFile,
  verifySqliteIntegrity,
} from "../runtime/backup.ts";
import { readMacKeychainSecret } from "../runtime/macos-keychain.ts";
import { canonicalJson } from "../core/deterministic.ts";

const dbPath = process.argv[2] ?? "data/commerce.sqlite";
const outputPath =
  process.argv[3] ?? "backups/commerce.sqlite.enc";

const keyHex =
  process.env.COSMO_BACKUP_KEY_HEX ??
  readMacKeychainSecret("cosmo-commerce", "backup-key");

const snapshotPath = `${outputPath}.plain.tmp`;
const verifyPath = `${outputPath}.verify.tmp`;
const database = openDatabase(dbPath, {
  appliedAt: new Date().toISOString(),
});

try {
  createConsistentSqliteBackup(database, snapshotPath);
  encryptBackupFile(snapshotPath, outputPath, keyHex);
} finally {
  database.close();
  rmSync(snapshotPath, { force: true });
}

try {
  decryptBackupFile(outputPath, verifyPath, keyHex);
  verifySqliteIntegrity(verifyPath);
  process.stdout.write(
    `${canonicalJson({
      database: dbPath,
      encryptedBackup: outputPath,
      integrity: "ok",
    })}\n`,
  );
} finally {
  rmSync(verifyPath, { force: true });
}
