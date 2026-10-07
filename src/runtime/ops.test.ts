import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  assertLiveMutationAllowed,
  evaluateLiveReadiness,
  GATE0_FIELDS,
  type Gate0Readiness,
} from "../live/readiness.ts";
import {
  createConsistentSqliteBackup,
  decryptBackupFile,
  encryptBackupFile,
  verifySqliteIntegrity,
} from "./backup.ts";
import { generateLaunchdPlist } from "./launchd.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function readiness(value: boolean): Gate0Readiness {
  return Object.fromEntries(
    GATE0_FIELDS.map((field) => [field, value]),
  ) as Gate0Readiness;
}

test("Gate 0 blocks every live mutation until all critical fields are ready", () => {
  const blocked = evaluateLiveReadiness(readiness(false));

  assert.equal(blocked.ready, false);
  assert.equal(blocked.missing.length, GATE0_FIELDS.length);
  assert.throws(
    () => assertLiveMutationAllowed(readiness(false)),
    /Live mutation blocked by Gate 0/,
  );

  const ready = evaluateLiveReadiness(readiness(true));
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);
  assert.doesNotThrow(() =>
    assertLiveMutationAllowed(readiness(true)),
  );
});

test("consistent SQLite backup encrypts, restores, and passes integrity check", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "cosmo-backup-test-"),
  );
  const sourcePath = join(directory, "source.sqlite");
  const plainPath = join(directory, "snapshot.sqlite");
  const encryptedPath = join(directory, "snapshot.sqlite.enc");
  const restoredPath = join(directory, "restored.sqlite");
  const keyHex = "11".repeat(32);

  const database = openDatabase(sourcePath, {
    appliedAt: T0,
  });

  try {
    database
      .prepare(
        `
          INSERT INTO rules (
            id,
            rule_key,
            version,
            enabled,
            value_json,
            updated_at
          ) VALUES (
            'rule-1',
            'backup-proof',
            1,
            1,
            '{"value":1}',
            ?
          )
        `,
      )
      .run(T0);

    createConsistentSqliteBackup(database, plainPath);
    encryptBackupFile(plainPath, encryptedPath, keyHex);
  } finally {
    database.close();
  }

  const encrypted = readFileSync(encryptedPath);
  assert.notEqual(
    encrypted.subarray(0, 16).toString("utf8"),
    "SQLite format 3\u0000",
  );
  assert.equal(
    encrypted.subarray(0, 9).toString("utf8"),
    "COSMOBKP1",
  );

  decryptBackupFile(encryptedPath, restoredPath, keyHex);
  verifySqliteIntegrity(restoredPath);

  const restored = openDatabase(restoredPath, {
    appliedAt: T0,
  });

  try {
    const row = restored
      .prepare(
        "SELECT value_json FROM rules WHERE rule_key = 'backup-proof'",
      )
      .get() as { value_json: string };

    assert.equal(row.value_json, '{"value":1}');
  } finally {
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore verification rejects missing and wrong-schema databases without creating them", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "cosmo-restore-invalid-"),
  );
  const missingPath = join(directory, "missing.sqlite");
  const wrongSchemaPath = join(directory, "wrong.sqlite");

  try {
    assert.throws(
      () => verifySqliteIntegrity(missingPath),
      /missing or empty/,
    );
    assert.equal(existsSync(missingPath), false);

    const wrong = new DatabaseSync(wrongSchemaPath);
    try {
      wrong.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    } finally {
      wrong.close();
    }

    assert.throws(
      () => verifySqliteIntegrity(wrongSchemaPath),
      /expected commerce schema/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("encrypted backup rejects wrong keys and tampering", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "cosmo-backup-tamper-"),
  );
  const sourcePath = join(directory, "source.sqlite");
  const plainPath = join(directory, "snapshot.sqlite");
  const encryptedPath = join(directory, "snapshot.sqlite.enc");
  const tamperedPath = join(directory, "tampered.sqlite.enc");
  const outputPath = join(directory, "output.sqlite");
  const keyHex = "22".repeat(32);

  const database = openDatabase(sourcePath, {
    appliedAt: T0,
  });
  try {
    createConsistentSqliteBackup(database, plainPath);
  } finally {
    database.close();
  }

  try {
    encryptBackupFile(plainPath, encryptedPath, keyHex);

    assert.throws(
      () =>
        decryptBackupFile(
          encryptedPath,
          outputPath,
          "33".repeat(32),
        ),
    );

    const tampered = Buffer.from(readFileSync(encryptedPath));
    const lastIndex = tampered.length - 1;
    if (lastIndex < 0) {
      throw new Error("Encrypted fixture unexpectedly empty.");
    }
    tampered[lastIndex] =
      (tampered[lastIndex] ?? 0) ^ 0xff;
    writeFileSync(tamperedPath, tampered);

    assert.throws(
      () =>
        decryptBackupFile(
          tamperedPath,
          outputPath,
          keyHex,
        ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("launchd template supervises the continuous local worker", () => {
  const plist = generateLaunchdPlist({
    label: "com.cosmo.commerce.worker",
    nodePath: "/opt/homebrew/bin/node",
    repoPath: "/Users/test/marketplace-commerce-engine",
    databasePath: "/Users/test/data/commerce.sqlite",
    intervalSeconds: 60,
    stdoutPath: "/Users/test/logs/worker.out.log",
    stderrPath: "/Users/test/logs/worker.err.log",
  });

  assert.match(plist, /src\/cli\/worker-loop\.ts/);
  assert.match(plist, /<integer>60<\/integer>/);
  assert.match(plist, /RunAtLoad/);

  assert.throws(
    () =>
      generateLaunchdPlist({
        label: "bad",
        nodePath: "node",
        repoPath: "/tmp",
        databasePath: "/tmp/db.sqlite",
        intervalSeconds: 30,
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
      }),
    /at least 60 seconds/,
  );
});
