import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./files.ts";
import { runCommand } from "./process.ts";

const ignoreEntries = ["config.json", "jawfish.json"];

export async function configureAgenticsRepoGitUser(
  agenticsRepoDir: string,
): Promise<void> {
  await ensureGitConfig(agenticsRepoDir, "user.email", "jawfish@example.invalid");
  await ensureGitConfig(agenticsRepoDir, "user.name", "Jawfish");
}

export async function ensureAgenticsRepoIgnore(
  agenticsRepoDir: string,
): Promise<void> {
  const ignorePath = join(agenticsRepoDir, ".gitignore");
  const existing = (await exists(ignorePath))
    ? await readFile(ignorePath, "utf8")
    : "";
  const existingEntries = new Set(
    existing.split("\n").map((line) => line.trim()),
  );
  const missing = ignoreEntries.filter((entry) => !existingEntries.has(entry));
  if (missing.length === 0) {
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(ignorePath, `${existing}${separator}${missing.join("\n")}\n`);
}

async function ensureGitConfig(
  agenticsRepoDir: string,
  key: string,
  value: string,
): Promise<void> {
  const current = await runCommand(
    "git",
    ["config", "--get", key],
    agenticsRepoDir,
    false,
  );
  if (current.exitCode !== 0 || current.stdout.trim() === "") {
    await runCommand("git", ["config", key, value], agenticsRepoDir);
  }
}
