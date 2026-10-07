import { readFileSync } from "node:fs";

import {
  evaluateLiveReadiness,
  parseGate0ReadinessJson,
} from "../live/readiness.ts";
import { canonicalJson } from "../core/deterministic.ts";

const path = process.argv[2] ?? "config/gate0.local.json";
const readiness = parseGate0ReadinessJson(
  readFileSync(path, "utf8"),
);
const decision = evaluateLiveReadiness(readiness);

process.stdout.write(
  `${canonicalJson({
    path,
    ready: decision.ready,
    missing: decision.missing,
  })}\n`,
);

if (!decision.ready) {
  process.exitCode = 2;
}
