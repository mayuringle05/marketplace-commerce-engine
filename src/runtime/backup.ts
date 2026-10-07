import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAGIC = Buffer.from("COSMOBKP1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseKeyHex(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("Backup key must be exactly 32 bytes of hex.");
  }
  return Buffer.from(keyHex, "hex");
}

export function assertDistinctFilePaths(
  sourcePath: string,
  outputPath: string,
): void {
  if (!existsSync(sourcePath)) {
    throw new Error("Source database does not exist.");
  }

  const sourceResolved = realpathSync(sourcePath);
  const outputResolved = existsSync(outputPath)
    ? realpathSync(outputPath)
    : resolve(outputPath);

  if (sourceResolved === outputResolved) {
    throw new Error("Backup output must not alias the source database.");
  }

  if (existsSync(outputPath)) {
    const sourceStat = statSync(sourceResolved);
    const outputStat = statSync(outputResolved);
    if (
      sourceStat.dev === outputStat.dev &&
      sourceStat.ino === outputStat.ino
    ) {
      throw new Error("Backup output must not alias the source database.");
    }
  }
}

export function createConsistentSqliteBackup(
  database: DatabaseSync,
  destinationPath: string,
): void {
  if (existsSync(destinationPath)) {
    throw new Error("Snapshot destination already exists.");
  }
  database.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
  chmodSync(destinationPath, 0o600);
}

export function encryptBackupFile(
  inputPath: string,
  outputPath: string,
  keyHex: string,
): void {
  const key = parseKeyHex(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = readFileSync(inputPath);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  writeFileSync(
    outputPath,
    Buffer.concat([MAGIC, iv, tag, ciphertext]),
    { mode: 0o600 },
  );
}

export function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  keyHex: string,
): void {
  const key = parseKeyHex(keyHex);
  const payload = readFileSync(inputPath);

  if (
    payload.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
    !payload.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("Encrypted backup header is invalid.");
  }

  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const dataStart = tagStart + TAG_BYTES;
  const iv = payload.subarray(ivStart, tagStart);
  const tag = payload.subarray(tagStart, dataStart);
  const ciphertext = payload.subarray(dataStart);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  writeFileSync(outputPath, plaintext, { mode: 0o600 });
}

export function verifySqliteIntegrity(path: string): void {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error("SQLite restore candidate is missing or empty.");
  }

  const database = new DatabaseSync(path, {
    readOnly: true,
    readBigInts: true,
    timeout: 5_000,
  });

  try {
    const integrity = database
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check: string };

    if (integrity.integrity_check !== "ok") {
      throw new Error(
        `SQLite integrity check failed: ${integrity.integrity_check}`,
      );
    }

    const foreignKeys = database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeys.length !== 0) {
      throw new Error("SQLite foreign-key check failed.");
    }

    const required = database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'schema_migrations',
              'products',
              'source_offers',
              'orders',
              'ledger_entries'
            )
        `,
      )
      .get() as { count: bigint };

    if (required.count !== 5n) {
      throw new Error("Backup does not contain the expected commerce schema.");
    }

    const migration = database
      .prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      )
      .get() as { version: bigint | null };
    if (migration.version === null) {
      throw new Error("Backup has no applied schema version.");
    }
  } finally {
    database.close();
  }
}

export function createVerifiedEncryptedBackup(
  sourcePath: string,
  database: DatabaseSync,
  outputPath: string,
  keyHex: string,
): void {
  assertDistinctFilePaths(sourcePath, outputPath);

  const outputDirectory = dirname(resolve(outputPath));
  const temporaryDirectory = mkdtempSync(
    join(outputDirectory, ".cosmo-backup-"),
  );
  chmodSync(temporaryDirectory, 0o700);

  const snapshotPath = join(temporaryDirectory, "snapshot.sqlite");
  const encryptedPath = join(temporaryDirectory, "snapshot.sqlite.enc");
  const verifyPath = join(temporaryDirectory, "verify.sqlite");

  try {
    createConsistentSqliteBackup(database, snapshotPath);
    encryptBackupFile(snapshotPath, encryptedPath, keyHex);
    decryptBackupFile(encryptedPath, verifyPath, keyHex);
    verifySqliteIntegrity(verifyPath);
    renameSync(encryptedPath, outputPath);
    chmodSync(outputPath, 0o600);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
