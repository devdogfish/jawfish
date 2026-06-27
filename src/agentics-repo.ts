import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  agenticTypes,
  catalogEntryIssues,
  readCatalog as readCatalogFile,
  readRawCatalog,
  writeCatalog as writeCatalogFile,
  type Catalog,
  type CatalogEntry,
} from "./catalog.ts";
import {
  configPath,
  deprecatedAgenticsRepoPath,
  jawfishHome,
  managedAgenticsRepoPath,
  saveConfig as saveJawfishConfig,
  type JawfishConfig,
} from "./config.ts";
import { errorHasCode } from "./errors.ts";
import { exists } from "./files.ts";
import { runCommand } from "./process.ts";
import { type AgenticType, typeFolder } from "./tool-adapters.ts";

const ignoreEntries = ["config.json", "jawfish.json"];

export interface AgenticsRepoInspection {
  broken: InspectionIssue[];
  catalogPath?: string;
  counts: Record<AgenticType, number>;
  usable: AgenticsRepoUsableEntry[];
  skipped: InspectionIssue[];
  usableNames: string[];
}

export interface AgenticsRepoUsableEntry {
  entry: CatalogEntry;
  name: string;
}

export interface InspectionIssue {
  reason: string;
  target: string;
}

type PushResult = { ok: true } | { ok: false; error: string };

export interface AgenticsRepoSession {
  dir: string;
  inspect: () => Promise<AgenticsRepoInspection>;
  pushChanges: (message: string) => Promise<boolean>;
  readCatalog: () => Promise<Catalog>;
  sync: () => Promise<void>;
  writeCatalog: (catalog: Catalog) => Promise<void>;
}

export interface AgenticsRepoSessionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AgenticsRepoSelection {
  createIfMissing: boolean;
  localPath: string;
  remoteSource?: string;
}

export async function openAgenticsRepoSession(
  config: JawfishConfig,
  options: AgenticsRepoSessionOptions = {},
): Promise<AgenticsRepoSession> {
  const dir = await resolveAgenticsRepoDir(config, options);
  return createAgenticsRepoSession(dir);
}

export function createAgenticsRepoSession(
  agenticsRepoDir: string,
): AgenticsRepoSession {
  return {
    dir: agenticsRepoDir,
    inspect: () => inspectAgenticsRepo(agenticsRepoDir),
    pushChanges: (message) => pushAgenticsRepoChanges(agenticsRepoDir, message),
    readCatalog: () => readCatalogFile(agenticsRepoDir),
    sync: () => syncAgenticsRepo(agenticsRepoDir),
    writeCatalog: (catalog) => writeCatalogFile(agenticsRepoDir, catalog),
  };
}

export async function resolveAgenticsRepoDir(
  config: JawfishConfig,
  options: AgenticsRepoSessionOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    const agenticsRepoDir = managedAgenticsRepoPath(env);
    await initializeLocalAgenticsRepo(agenticsRepoDir);
    config.agenticsRepo = agenticsRepoDir;
    await saveJawfishConfig(config, { env });
    return agenticsRepoDir;
  }

  const configured = resolveConfiguredAgenticsRepoPath(config.agenticsRepo, cwd);
  assertNotDeprecatedAgenticsRepoPath(configured, env);

  if ((await exists(configured)) && !(await isBareAgenticsRepo(configured))) {
    await prepareExistingAgenticsRepo(configured);
    return configured;
  }

  const agenticsRepoDir = managedAgenticsRepoPath(env);
  if (await exists(join(agenticsRepoDir, ".git"))) {
    await prepareExistingAgenticsRepo(agenticsRepoDir);
    return agenticsRepoDir;
  }

  await initializeRemoteAgenticsRepo(config.agenticsRepo, agenticsRepoDir);
  return agenticsRepoDir;
}

export async function prepareAgenticsRepoSelection(
  selection: AgenticsRepoSelection,
  options: AgenticsRepoSessionOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const localPath = resolveConfiguredAgenticsRepoPath(selection.localPath, cwd);

  if (selection.remoteSource === undefined) {
    const linkedPathExists = await exists(localPath);
    if (!linkedPathExists && !selection.createIfMissing) {
      throw new Error(`Agentics repo path not found: ${selection.localPath}`);
    }

    await initializeLocalAgenticsRepo(localPath);
    return localPath;
  }

  await initializeRemoteAgenticsRepo(selection.remoteSource, localPath);
  return localPath;
}

export async function syncAgenticsRepo(agenticsRepoDir: string): Promise<void> {
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    return;
  }

  const upstream = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    agenticsRepoDir,
    false,
  );
  if (upstream.exitCode !== 0) {
    return;
  }

  await runCommand("git", ["pull", "--ff-only"], agenticsRepoDir);
}

export async function agenticsRepoOriginRemote(
  agenticsRepoDir: string,
): Promise<string | undefined> {
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    return undefined;
  }

  const result = await runCommand(
    "git",
    ["remote", "get-url", "origin"],
    agenticsRepoDir,
    false,
  );
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    return undefined;
  }

  return result.stdout.trim();
}

export async function inspectionAgenticsRepoDir(
  agenticsRepo: string,
  options: AgenticsRepoSessionOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configured = resolveConfiguredAgenticsRepoPath(agenticsRepo, cwd);
  if ((await exists(configured)) && !(await isBareAgenticsRepo(configured))) {
    return configured;
  }

  return managedAgenticsRepoPath(env);
}

export function assertAgenticsRepoPathSupported(
  agenticsRepo: string,
  options: AgenticsRepoSessionOptions = {},
): void {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configured = resolveConfiguredAgenticsRepoPath(agenticsRepo, cwd);
  assertNotDeprecatedAgenticsRepoPath(configured, env);
}

export function resolveConfiguredAgenticsRepoPath(
  path: string,
  cwd: string,
): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function looksLikeAgenticsRepoRemote(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /^[^@\s]+@[^:\s]+:.+/.test(value)
  );
}

export async function isBareAgenticsRepo(path: string): Promise<boolean> {
  if (!(await exists(path))) {
    return false;
  }

  const result = await runCommand(
    "git",
    ["rev-parse", "--is-bare-repository"],
    path,
    false,
  );
  return result.exitCode === 0 && result.stdout.trim() === "true";
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

async function initializeLocalAgenticsRepo(
  agenticsRepoDir: string,
): Promise<void> {
  await ensureGitRepository(agenticsRepoDir);
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function prepareExistingAgenticsRepo(
  agenticsRepoDir: string,
): Promise<void> {
  if (await exists(join(agenticsRepoDir, ".git"))) {
    await configureAgenticsRepoGitUser(agenticsRepoDir);
  }

  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function initializeRemoteAgenticsRepo(
  source: string,
  agenticsRepoDir: string,
): Promise<void> {
  await ensureGitRepository(agenticsRepoDir);
  await configureOriginRemote(source, agenticsRepoDir);
  await runCommand("git", ["fetch", "origin"], agenticsRepoDir);

  const branch = await remoteDefaultBranch(agenticsRepoDir);
  if (branch === undefined) {
    await runCommand("git", ["checkout", "-B", "main"], agenticsRepoDir);
    await ensureAgenticsRepoIgnore(agenticsRepoDir);
    return;
  }

  await runCommand(
    "git",
    ["checkout", "-B", branch, `origin/${branch}`],
    agenticsRepoDir,
  );
  await runCommand(
    "git",
    ["branch", "--set-upstream-to", `origin/${branch}`, branch],
    agenticsRepoDir,
  );
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function ensureGitRepository(agenticsRepoDir: string): Promise<void> {
  await mkdir(agenticsRepoDir, { recursive: true });
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    await runCommand("git", ["init"], agenticsRepoDir);
  }

  await configureAgenticsRepoGitUser(agenticsRepoDir);
}

async function configureOriginRemote(
  source: string,
  agenticsRepoDir: string,
): Promise<void> {
  if ((await agenticsRepoOriginRemote(agenticsRepoDir)) === undefined) {
    await runCommand("git", ["remote", "add", "origin", source], agenticsRepoDir);
    return;
  }

  await runCommand(
    "git",
    ["remote", "set-url", "origin", source],
    agenticsRepoDir,
  );
}

async function remoteDefaultBranch(
  agenticsRepoDir: string,
): Promise<string | undefined> {
  const result = await runCommand(
    "git",
    ["ls-remote", "--symref", "origin", "HEAD"],
    agenticsRepoDir,
  );
  const match = /^ref: refs\/heads\/([^\t]+)\tHEAD$/mu.exec(result.stdout);
  if (match === null) {
    return undefined;
  }

  return match[1];
}

function assertNotDeprecatedAgenticsRepoPath(
  configured: string,
  env: NodeJS.ProcessEnv,
): void {
  if (resolve(configured) !== resolve(deprecatedAgenticsRepoPath(env))) {
    return;
  }

  throw new Error(
    `Nested agentics repo is no longer supported: ${configured}\n` +
      `Move the repo to ${managedAgenticsRepoPath(env)} and update ` +
      `${configPath(jawfishHome(env))}.`,
  );
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
    usable: [],
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
    inspection.usable.push({ entry: catalogEntry, name });
    inspection.usableNames.push(name);
  }

  inspection.usable.sort((left, right) => left.name.localeCompare(right.name));
  inspection.usableNames.sort((left, right) => left.localeCompare(right));
  inspection.skipped = await unregisteredEntries(agenticsRepoDir, registeredPaths);
  return inspection;
}

export async function pushAgenticsRepoChanges(
  agenticsRepoDir: string,
  message: string,
): Promise<boolean> {
  const pushResult = await commitAndPush(agenticsRepoDir, message);
  if (pushResult.ok) {
    return true;
  }

  printPushFailure(pushResult.error, agenticsRepoDir);
  return false;
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

async function commitAndPush(
  agenticsRepoDir: string,
  message: string,
): Promise<PushResult> {
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    return { ok: true };
  }

  await ensureAgenticsRepoIgnore(agenticsRepoDir);
  await runCommand("git", ["add", "."], agenticsRepoDir);
  const status = await runCommand("git", ["status", "--porcelain"], agenticsRepoDir);
  if (status.stdout.trim() === "") {
    return { ok: true };
  }

  await runCommand("git", ["commit", "-m", message], agenticsRepoDir);
  if (await hasPushDestination(agenticsRepoDir)) {
    const push = await runCommand("git", ["push"], agenticsRepoDir, false);
    if (push.exitCode !== 0) {
      return { ok: false, error: push.stderr || push.stdout };
    }

    return { ok: true };
  }

  if (!(await hasOriginRemote(agenticsRepoDir))) {
    return { ok: true };
  }

  const push = await runCommand(
    "git",
    ["push", "-u", "origin", "HEAD"],
    agenticsRepoDir,
    false,
  );
  if (push.exitCode !== 0) {
    return { ok: false, error: push.stderr || push.stdout };
  }

  return { ok: true };
}

async function hasPushDestination(agenticsRepoDir: string): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    agenticsRepoDir,
    false,
  );

  return result.exitCode === 0 && result.stdout.trim() !== "";
}

async function hasOriginRemote(agenticsRepoDir: string): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["remote", "get-url", "origin"],
    agenticsRepoDir,
    false,
  );

  return result.exitCode === 0 && result.stdout.trim() !== "";
}

function printPushFailure(error: string, agenticsRepoDir: string): void {
  console.error("Agentics repo commit was created, but push failed.");
  console.error(error.trim());
  console.error(`Recover with: git -C ${agenticsRepoDir} push`);
}
