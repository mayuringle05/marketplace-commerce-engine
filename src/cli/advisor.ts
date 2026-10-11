import { readFileSync } from "node:fs";

import { canonicalJson } from "../core/deterministic.ts";
import { openDatabase } from "../db/database.ts";
import {
  buildCommerceAdvisorPacket,
  parseCommerceAdvisorExportRequest,
  persistCommerceAdvice,
  validateCommerceAdvicePack,
} from "../research/advisor.ts";

const command = process.argv[2];
const inputPath = process.argv[3];
const dbPath = process.argv[4] ?? "data/commerce.sqlite";

if (command !== "export" && command !== "import") {
  throw new Error(
    "Usage: advisor <export|import> <jsonPath> [dbPath]",
  );
}
if (inputPath === undefined) {
  throw new Error(
    "Usage: advisor <export|import> <jsonPath> [dbPath]",
  );
}

const now = new Date().toISOString();
const database = openDatabase(dbPath, {
  appliedAt: now,
});

try {
  if (command === "export") {
    const request = parseCommerceAdvisorExportRequest(
      readFileSync(inputPath, "utf8"),
    );
    const packet = buildCommerceAdvisorPacket(
      database,
      request,
      now,
    );
    process.stdout.write(`${canonicalJson(packet)}\n`);
  } else {
    const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    const requestPath = process.env.COMMERCE_ADVISOR_PACKET;
    if (
      typeof requestPath !== "string" ||
      requestPath.trim().length === 0
    ) {
      throw new Error(
        "COMMERCE_ADVISOR_PACKET must point to the exact advisor packet used to generate this advice.",
      );
    }
    const packet = JSON.parse(
      readFileSync(requestPath, "utf8"),
    ) as ReturnType<typeof buildCommerceAdvisorPacket>;
    const advice = validateCommerceAdvicePack(raw, packet);
    const imported = persistCommerceAdvice(database, advice);
    process.stdout.write(
      `${canonicalJson({
        schemaVersion: 1,
        imported,
        transactionAuthority: false,
        supplierContactAuthority: false,
      })}\n`,
    );
  }
} finally {
  database.close();
}
