import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { AgenticsConfig } from "./config.ts";

export function managedLibraryPath(agenticsHome: string): string {
  return join(agenticsHome, "content-library");
}

export async function ensureContentLibrary(
  config: AgenticsConfig,
  agenticsHome: string,
): Promise<string> {
  if (config.contentLibrary === undefined) {
    throw new Error(
      "Missing contentLibrary in config. Set AGENTICS_CONTENT_LIBRARY for first run or edit config.json.",
    );
  }

  const libraryDir = managedLibraryPath(agenticsHome);

  if (existsSync(join(libraryDir, ".git"))) {
    return libraryDir;
  }

  if (existsSync(libraryDir)) {
    throw new Error(`Managed content library exists but is not a git clone: ${libraryDir}`);
  }

  await mkdir(agenticsHome, { recursive: true });
  await runGit(["clone", config.contentLibrary, libraryDir], agenticsHome);

  return libraryDir;
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}
