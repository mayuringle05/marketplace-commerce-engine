import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const mode = process.argv[2];
if (mode !== "format" && mode !== "lint") {
  throw new Error("Usage: node scripts/verify-source.mjs <format|lint>");
}

const ROOT = process.cwd();
const CODE_DIRS = ["src", "scripts"];
const CONFIG_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".github/workflows/ci.yml",
  ".env.example",
  ".gitignore",
];

async function collectFiles(directory) {
  const output = [];
  const entries = await readdir(join(ROOT, directory), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await collectFiles(path)));
      continue;
    }
    output.push(path);
  }

  return output;
}

const codeFiles = (
  await Promise.all(CODE_DIRS.map((directory) => collectFiles(directory)))
)
  .flat()
  .filter((path) => [".ts", ".mjs"].includes(extname(path)));

const files = [...codeFiles, ...CONFIG_FILES];
const failures = [];

function fail(path, message) {
  failures.push(`${path}: ${message}`);
}

for (const path of files) {
  const source = await readFile(join(ROOT, path), "utf8");

  if (mode === "format") {
    if (source.includes("\r")) {
      fail(path, "CRLF/CR line endings are not allowed; use LF.");
    }
    if (!source.endsWith("\n")) {
      fail(path, "file must end with exactly one newline.");
    }
    if (source.endsWith("\n\n")) {
      fail(path, "file must not contain multiple trailing blank lines.");
    }

    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      if (/\s+$/.test(line)) {
        fail(path, `line ${index + 1} has trailing whitespace.`);
      }
      if (line.includes("\t")) {
        fail(path, `line ${index + 1} contains a tab character.`);
      }
    }

    if (extname(path) === ".json") {
      try {
        const parsed = JSON.parse(source);
        const canonical = JSON.stringify(parsed, null, 2) + "\n";
        if (source !== canonical) {
          fail(path, "JSON must use canonical two-space formatting.");
        }
      } catch (error) {
        fail(path, `invalid JSON: ${String(error)}`);
      }
    }
  }

  if (mode === "lint" && extname(path) === ".ts") {
    const forbidden = [
      ["@ts-ignore", "do not suppress TypeScript errors with @ts-ignore"],
      ["@ts-nocheck", "do not disable TypeScript checking"],
      ["debugger", "debugger statements are forbidden"],
      ["console.", "production economics code must not use console side effects"],
      [": any", "explicit any is forbidden in deterministic core code"],
      [" as any", "casts to any are forbidden in deterministic core code"],
    ];

    for (const [token, message] of forbidden) {
      if (source.includes(token)) {
        fail(path, message);
      }
    }

    if (path.startsWith("src/economics/")) {
      const floatMoneyTokens = [
        "parseFloat(",
        ".toFixed(",
        "Math.round(",
        "Math.floor(",
        "Math.ceil(",
      ];
      for (const token of floatMoneyTokens) {
        if (source.includes(token)) {
          fail(
            path,
            `${token} is forbidden in economics code; use rational money helpers`,
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `${mode} verification failed:\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${mode} verification passed for ${files.length} files.\n`,
  );
}
