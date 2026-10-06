import { execFileSync } from "node:child_process";

export function readMacKeychainSecret(
  service: string,
  account: string,
): string {
  if (process.platform !== "darwin") {
    throw new Error(
      "macOS Keychain access is only available on Darwin.",
    );
  }

  return execFileSync(
    "security",
    [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
