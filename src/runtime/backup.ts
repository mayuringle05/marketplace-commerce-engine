import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

export function createConsistentSqliteBackup(
  database: DatabaseSync,
  destinationPath: string,
): void {
  rmSync(destinationPath, { force: true });
  database.exec(
    `VACUUM INTO ${sqlString(destinationPath)}`,
  );
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

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    iv,
  );
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  writeFileSync(outputPath, plaintext);
}

export function verifySqliteIntegrity(path: string): void {
  const database = new DatabaseSync(path, {
    readBigInts: true,
    timeout: 5_000,
  });

  try {
    const row = database
      .prepare("PRAGMA integrity_check")
      .get() as { integrity_check: string };

    if (row.integrity_check !== "ok") {
      throw new Error(
        `SQLite integrity check failed: ${row.integrity_check}`,
      );
    }
  } finally {
    database.close();
  }
}
