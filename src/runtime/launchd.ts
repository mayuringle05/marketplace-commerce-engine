export interface LaunchdConfig {
  readonly label: string;
  readonly nodePath: string;
  readonly repoPath: string;
  readonly databasePath: string;
  readonly intervalSeconds: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function generateLaunchdPlist(
  config: LaunchdConfig,
): string {
  if (
    !Number.isSafeInteger(config.intervalSeconds) ||
    config.intervalSeconds < 60
  ) {
    throw new Error(
      "launchd interval must be an integer of at least 60 seconds.",
    );
  }

  const args = [
    config.nodePath,
    "src/cli/worker-loop.ts",
    config.databasePath,
  ];

  const argXml = args
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.repoPath)}</string>
  <key>StartInterval</key>
  <integer>${config.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.stderrPath)}</string>
</dict>
</plist>
`;
}
