import { openDatabase } from "../db/database.ts";
import {
  buildResearchPacket,
  importChatGptDecisionFile,
  writeResearchPacketFile,
} from "../research/chatgpt-handoff.ts";
import { canonicalJson } from "../core/deterministic.ts";

const command = process.argv[2];
const dbPath = process.argv[3] ?? "data/commerce.sqlite";
const filePath = process.argv[4];

if (
  (command !== "export" && command !== "import") ||
  filePath === undefined
) {
  throw new Error(
    "Usage: research <export|import> [dbPath] <jsonPath>",
  );
}

const now = new Date().toISOString();
const database = openDatabase(dbPath, {
  appliedAt: now,
});

try {
  if (command === "export") {
    const packet = buildResearchPacket(database, now);
    const expiresAt = new Date(
      new Date(now).getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString();
    const inputHash = writeResearchPacketFile(
      database,
      filePath,
      packet,
      expiresAt,
    );
    process.stdout.write(
      `${canonicalJson({ filePath, inputHash })}\n`,
    );
  } else {
    const id = importChatGptDecisionFile(
      database,
      filePath,
      now,
    );
    process.stdout.write(
      `${canonicalJson({ filePath, decisionId: id })}\n`,
    );
  }
} finally {
  database.close();
}
