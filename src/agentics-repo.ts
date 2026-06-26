import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  agenticTypes,
  catalogEntryIssues,
  readRawCatalog,
  type CatalogEntry,
} from "./catalog.ts";
import { errorHasCode } from "./errors.ts";
import { exists } from "./files.ts";
import { runCommand } from "./process.ts";
import { type AgenticType, typeFolder } from "./tool-adapters.ts";

const ignoreEntries = ["config.json", "jawfish.json"];

export interface AgenticsRepoInspection {
  broken: InspectionIssue[];
  catalogPath?: string;
  counts: Record<AgenticType, number>;
  skipped: InspectionIssue[];
  usableNames: string[];
}

export interface InspectionIssue {
  reason: string;
  target: string;
}

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

export async function inspectAgenticsRepo(
  agenticsRepoDir: string,
): Promise<AgenticsRepoInspection> {
  const raw = await readRawCatalog(agenticsRepoDir);
  const registeredPaths = new Set<string>();
  const inspection: AgenticsRepoInspection = {
    broken: [],
    catalogPath: raw.path,
    counts: { agent: 0, prompt: 0, skill: 0 },
    skipped: [],
    usableNames: [],
  };

  for (const [name, entry] of Object.entries(raw.entries)) {
    const issues = catalogEntryIssues(name, entry);
    if (issues.length > 0) {
      inspection.broken.push({ target: name, reason: issues.join(", ") });
      continue;
    }

    const catalogEntry = entry as CatalogEntry;
    inspection.counts[catalogEntry.type] += 1;
    const pathIssue = await registeredPathIssue(agenticsRepoDir, catalogEntry);
    if (pathIssue !== undefined) {
      inspection.broken.push({ target: name, reason: pathIssue });
      continue;
    }

    registeredPaths.add(normalizeRepoPath(catalogEntry.path));
    inspection.usableNames.push(name);
  }

  inspection.usableNames.sort((left, right) => left.localeCompare(right));
  inspection.skipped = await unregisteredEntries(agenticsRepoDir, registeredPaths);
  return inspection;
}

async function registeredPathIssue(
  agenticsRepoDir: string,
  entry: CatalogEntry,
): Promise<string | undefined> {
  const resolved = resolveInside(agenticsRepoDir, entry.path);
  if (resolved === undefined) {
    return `path escapes agentics repo: ${entry.path}`;
  }

  try {
    await stat(resolved);
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return `path not found: ${entry.path}`;
    }

    throw error;
  }

  return undefined;
}

async function unregisteredEntries(
  agenticsRepoDir: string,
  registeredPaths: Set<string>,
): Promise<InspectionIssue[]> {
  const skipped: InspectionIssue[] = [];

  for (const type of agenticTypes) {
    const folder = typeFolder(type);
    const root = join(agenticsRepoDir, folder);
    if (!(await exists(root))) {
      continue;
    }

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const repoPath = normalizeRepoPath(join(folder, entry.name));
      if (registeredPaths.has(repoPath)) {
        continue;
      }

      const path = join(root, entry.name);
      if (entry.isDirectory() && (await directoryFileCount(path)) === 0) {
        skipped.push({ target: repoPath, reason: "empty package" });
        continue;
      }

      if (entry.isDirectory() || entry.isFile()) {
        skipped.push({ target: repoPath, reason: "not registered" });
      }
    }
  }

  return skipped.sort((left, right) => left.target.localeCompare(right.target));
}

async function directoryFileCount(path: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      count += await directoryFileCount(entryPath);
      continue;
    }

    if (entry.isFile()) {
      count += 1;
    }
  }

  return count;
}

function resolveInside(root: string, path: string): string | undefined {
  const resolved = resolve(root, path);
  const parentRelative = relative(root, resolved);
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    return undefined;
  }

  return resolved;
}

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
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
