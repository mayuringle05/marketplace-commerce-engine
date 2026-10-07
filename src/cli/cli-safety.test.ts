import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { seedSingleSkuFixture } from "../test/commerce-fixture.ts";

const T0 = "2026-10-07T00:00:00.000Z";

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(
    process.execPath,
    args,
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    },
  );
}

test("exposure pause CLI confirms zero quantity for active listings", () => {
  const directory = mkdtempSync(join(tmpdir(), "cosmo-cli-pause-"));
  const dbPath = join(directory, "commerce.sqlite");
  const database = openDatabase(dbPath, {
    appliedAt: T0,
  });

  try {
    seedSingleSkuFixture(database, {
      listingQuantity: 2,
    });
  } finally {
    database.close();
  }

  try {
    const result = runCli([
      "src/cli/exposure.ts",
      "pause",
      dbPath,
      "CLI_TEST_PAUSE",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"stopNewExposure":true/);

    const check = openDatabase(dbPath, {
      appliedAt: T0,
    });
    try {
      const local = check
        .prepare(
          `
            SELECT observed_state, observed_quantity
            FROM listings
            WHERE seller_sku = 'SELLER-1'
          `,
        )
        .get() as {
        observed_state: string;
        observed_quantity: bigint;
      };
      const remote = check
        .prepare(
          `
            SELECT state, quantity
            FROM simulated_marketplace_listings
            WHERE marketplace = 'SIM'
              AND seller_sku = 'SELLER-1'
          `,
        )
        .get() as { state: string; quantity: bigint };

      assert.equal(local.observed_state, "PAUSED");
      assert.equal(local.observed_quantity, 0n);
      assert.equal(remote.state, "PAUSED");
      assert.equal(remote.quantity, 0n);
    } finally {
      check.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("demo CLI refuses an existing operational database without deleting it", () => {
  const directory = mkdtempSync(join(tmpdir(), "cosmo-cli-demo-"));
  const dbPath = join(directory, "commerce.sqlite");
  const database = openDatabase(dbPath, {
    appliedAt: T0,
  });

  try {
    database
      .prepare(
        `
          INSERT INTO rules (
            id, rule_key, version, enabled, value_json, updated_at
          ) VALUES (
            'sentinel', 'sentinel', 1, 1, '{"alive":true}', ?
          )
        `,
      )
      .run(T0);
  } finally {
    database.close();
  }

  try {
    const result = runCli([
      "src/cli/e2e-demo.ts",
      dbPath,
    ]);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Refusing to overwrite it/,
    );

    const check = openDatabase(dbPath, {
      appliedAt: T0,
    });
    try {
      const sentinel = check
        .prepare(
          "SELECT value_json FROM rules WHERE rule_key = 'sentinel'",
        )
        .get() as { value_json: string };
      assert.equal(sentinel.value_json, '{"alive":true}');
    } finally {
      check.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("backup CLI rejects source/output alias and preserves the live SQLite database", () => {
  const directory = mkdtempSync(join(tmpdir(), "cosmo-cli-backup-"));
  const dbPath = join(directory, "commerce.sqlite");
  const database = openDatabase(dbPath, {
    appliedAt: T0,
  });

  try {
    database
      .prepare(
        `
          INSERT INTO rules (
            id, rule_key, version, enabled, value_json, updated_at
          ) VALUES (
            'sentinel', 'sentinel', 1, 1, '{"alive":true}', ?
          )
        `,
      )
      .run(T0);
  } finally {
    database.close();
  }

  try {
    const result = runCli(
      [
        "src/cli/backup.ts",
        dbPath,
        dbPath,
      ],
      {
        ...process.env,
        COSMO_BACKUP_KEY_HEX: "11".repeat(32),
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /must not alias the source database/,
    );

    const check = openDatabase(dbPath, {
      appliedAt: T0,
    });
    try {
      const sentinel = check
        .prepare(
          "SELECT value_json FROM rules WHERE rule_key = 'sentinel'",
        )
        .get() as { value_json: string };
      assert.equal(sentinel.value_json, '{"alive":true}');
    } finally {
      check.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
