import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { type Catalog, type CatalogEntry } from "./catalog.ts";
import { type JawfishConfig } from "./config.ts";
import { exists } from "./files.ts";
import { gitRemoteOrigin, gitTopLevelPath } from "./git-source.ts";
import { runCommand } from "./process.ts";

export interface AcquiredSource {
  entryFile?: string;
  inferredName: string;
  packagePath: string;
}

export interface GitHubRepoSource {
  directRelativePath?: string;
  ref?: string;
  repoUrl: string;
  rootPath: string;
  upstreamKind: "github";
}

export interface LocalRepoSource {
  directRelativePath?: string;
  origin?: string;
  rootPath: string;
  upstreamKind: "local";
}

export type RepoSource = GitHubRepoSource | LocalRepoSource;

export type RepoSkillCandidateState = "conflict" | "existing" | "new";

export interface RepoSkillCandidate {
  catalogName: string;
  conflict: boolean;
  existing: boolean;
  name: string;
  relativePath: string;
  sourcePath: string;
  state: RepoSkillCandidateState;
  upstream: string;
}

export interface RepoSkillIntakePlan {
  candidates: RepoSkillCandidate[];
  directCandidate?: RepoSkillCandidate;
  initialRelativePaths: string[];
}

export interface PackageUpdate {
  catalogEntry: CatalogEntry;
  sourcePath: string;
}

interface ParsedGitHubSource {
  directRelativePath?: string;
  path?: string;
  ref?: string;
  repoUrl: string;
}

interface GitFragmentSource {
  relativePath: string;
  source: string;
}

interface UrlResponse {
  body: Buffer;
  contentType: string;
  links: string[];
}

export async function acquireSource(source: string): Promise<AcquiredSource> {
  const fragmentSource = await acquireGitFragmentSource(source);
  if (fragmentSource !== undefined) {
    return fragmentSource;
  }

  const repoSource = await acquireRepoSource(source);
  if (
    repoSource !== undefined &&
    repoSource.directRelativePath !== undefined
  ) {
    const packagePath = join(repoSource.rootPath, repoSource.directRelativePath);
    return {
      inferredName: inferPackageName(packagePath),
      packagePath,
    };
  }

  return isUrl(source) ? acquireUrlSource(source) : acquireLocalSource(source);
}

export async function isImportSource(source: string): Promise<boolean> {
  if (isUrl(source)) {
    return true;
  }

  const fragment = splitGitFragmentSource(source);
  if (fragment !== undefined) {
    return exists(resolve(process.cwd(), fragment.source));
  }

  return exists(resolve(process.cwd(), source));
}

export async function acquireRepoSource(
  source: string,
): Promise<RepoSource | undefined> {
  const github = parseGitHubSource(source);
  if (github !== undefined) {
    return acquireGitHubRepoSource(github);
  }

  return acquireLocalRepoSource(source);
}

export function shouldScanRepoSkills(
  repoSource: RepoSource,
  config: JawfishConfig,
): boolean {
  if (!isDirectRepoSkillSource(repoSource)) {
    return true;
  }

  return config.autoScanRepoSkills !== false;
}

export function isDirectRepoSkillSource(repoSource: RepoSource): boolean {
  return repoSource.directRelativePath !== undefined;
}

export async function planRepoSkillIntake(
  catalog: Catalog,
  repoSource: RepoSource,
): Promise<RepoSkillIntakePlan> {
  const candidates = await repoSkillCandidates(catalog, repoSource);
  const directCandidate = directRepoSkillCandidate(candidates, repoSource);

  return {
    candidates,
    directCandidate,
    initialRelativePaths: repoSkillInitialSelections(candidates, directCandidate),
  };
}

export function automaticRepoSkillSelection(
  plan: RepoSkillIntakePlan,
  yes: boolean,
): RepoSkillCandidate[] | undefined {
  if (plan.directCandidate !== undefined) {
    return [plan.directCandidate];
  }

  if (yes) {
    return plan.candidates.filter((candidate) => !candidate.conflict);
  }

  return undefined;
}

export function repoSkillCandidatesByRelativePath(
  plan: RepoSkillIntakePlan,
  relativePaths: Iterable<string>,
): RepoSkillCandidate[] {
  const selectedPaths = new Set(relativePaths);
  return plan.candidates.filter((candidate) =>
    selectedPaths.has(candidate.relativePath)
  );
}

export function unselectedRepoSiblingCount(
  plan: RepoSkillIntakePlan,
  selectedCandidates: RepoSkillCandidate[],
  repoSource: RepoSource,
): number {
  if (!isDirectRepoSkillSource(repoSource)) {
    return 0;
  }

  const selectedPaths = new Set(
    selectedCandidates.map((candidate) => candidate.relativePath),
  );
  return plan.candidates.filter(
    (candidate) =>
      candidate.relativePath !== repoSource.directRelativePath &&
      !selectedPaths.has(candidate.relativePath),
  ).length;
}

export function assertRepoSkillSelection(
  candidates: RepoSkillCandidate[],
): void {
  const conflicts = candidates
    .filter((candidate) => candidate.conflict)
    .map((candidate) => candidate.name);
  if (conflicts.length > 0) {
    throw new Error(
      `Repo skill name conflicts: ${conflicts.join(", ")}`,
    );
  }
}

export function catalogNameForUpstream(
  catalog: Catalog,
  source: string,
): string | undefined {
  for (const [name, entry] of Object.entries(catalog.jawfish)) {
    if (isSameUpstream(entry.upstream, source)) {
      return name;
    }
  }

  return undefined;
}

export function isSameUpstream(
  existing: string | undefined,
  source: string,
): boolean {
  if (existing === undefined) {
    return false;
  }

  if (isUrl(existing) && isUrl(source)) {
    return normalizeSourceUrl(existing) === normalizeSourceUrl(source);
  }

  if (!isUrl(existing) && !isUrl(source)) {
    return resolve(process.cwd(), existing) === resolve(process.cwd(), source);
  }

  return existing === source;
}

export async function preparePackageUpdate(
  agenticsRepoDir: string,
  catalog: Catalog,
  name: string,
  force: boolean,
): Promise<PackageUpdate> {
  const entry = catalog.jawfish[name];
  if (entry === undefined) {
    throw new Error(`Unknown agentic: ${name}`);
  }

  if (entry.upstream === undefined) {
    throw new Error(`Agentic has no upstream: ${name}`);
  }

  const dirty = await dirtyPaths(agenticsRepoDir, entry.path);
  if (dirty.length > 0 && !force) {
    throw new Error(
      `Package has dirty local changes: ${name}\n` +
        dirty.map((path) => `  ${path}`).join("\n") +
        "\nRun jawfish update --force " +
        name +
        " to replace them.",
    );
  }

  return {
    catalogEntry: entry,
    sourcePath: (await acquireSource(entry.upstream)).packagePath,
  };
}

export function normalizeSourceUrl(source: string): string {
  const url = new URL(source);
  if (url.hostname !== "github.com") {
    return source;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "blob") {
    return source;
  }

  const [owner, repo, , branch, ...path] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path.join("/")}`;
}

function repoSkillCandidates(
  catalog: Catalog,
  repoSource: RepoSource,
): Promise<RepoSkillCandidate[]> {
  return findSkillDirectories(repoSource.rootPath).then((skillDirs) =>
    skillDirs
      .map((sourcePath) => repoSkillCandidate(catalog, repoSource, sourcePath))
      .sort((left, right) => left.name.localeCompare(right.name))
  );
}

function repoSkillCandidate(
  catalog: Catalog,
  repoSource: RepoSource,
  sourcePath: string,
): RepoSkillCandidate {
  const relativePath =
    normalizePath(relative(repoSource.rootPath, sourcePath)) || ".";
  const upstream = repoSkillUpstream(repoSource, relativePath, sourcePath);
  const existingName = catalogNameForUpstream(catalog, upstream);
  const name = repoSkillCandidateName(repoSource, relativePath, sourcePath);
  const nameEntry = catalog.jawfish[name];
  const existing = existingName !== undefined;
  const conflict =
    !existing &&
    nameEntry !== undefined &&
    !isSameUpstream(nameEntry.upstream, upstream);
  const state = repoSkillCandidateState(existing, conflict);

  return {
    catalogName: existingName ?? name,
    conflict,
    existing,
    name,
    relativePath,
    sourcePath,
    state,
    upstream,
  };
}

function repoSkillCandidateState(
  existing: boolean,
  conflict: boolean,
): RepoSkillCandidateState {
  if (conflict) {
    return "conflict";
  }

  if (existing) {
    return "existing";
  }

  return "new";
}

function repoSkillCandidateName(
  repoSource: RepoSource,
  relativePath: string,
  sourcePath: string,
): string {
  if (relativePath === ".") {
    return inferPackageName(repoSource.rootPath);
  }

  return basename(sourcePath);
}

async function findSkillDirectories(rootPath: string): Promise<string[]> {
  const found: string[] = [];

  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(path);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipRepoScanEntry(entry.name)) {
        continue;
      }

      await visit(join(path, entry.name));
    }
  }

  await visit(rootPath);
  return found;
}

function shouldSkipRepoScanEntry(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "dist";
}

function repoSkillUpstream(
  repoSource: RepoSource,
  relativePath: string,
  sourcePath: string,
): string {
  if (repoSource.upstreamKind === "github") {
    return githubTreeUrl(
      repoSource.repoUrl,
      repoSource.ref ?? "HEAD",
      relativePath,
    );
  }

  if (repoSource.origin !== undefined) {
    return `${repoSource.origin}#${relativePath}`;
  }

  return sourcePath;
}

function directRepoSkillCandidate(
  candidates: RepoSkillCandidate[],
  repoSource: RepoSource,
): RepoSkillCandidate | undefined {
  if (repoSource.directRelativePath === undefined) {
    return undefined;
  }

  return candidates.find(
    (candidate) => candidate.relativePath === repoSource.directRelativePath,
  );
}

function repoSkillInitialSelections(
  candidates: RepoSkillCandidate[],
  direct: RepoSkillCandidate | undefined,
): string[] {
  if (direct !== undefined) {
    return [direct.relativePath];
  }

  return candidates
    .filter((candidate) => candidate.existing && !candidate.conflict)
    .map((candidate) => candidate.relativePath);
}

async function acquireGitHubRepoSource(
  parsed: ParsedGitHubSource,
): Promise<GitHubRepoSource> {
  const tempDir = await mkdtemp(join(tmpdir(), "jawfish-repo-"));
  await runCommand("git", ["clone", "--quiet", parsed.repoUrl, tempDir], process.cwd());
  if (parsed.ref !== undefined) {
    await runCommand("git", ["checkout", "--quiet", parsed.ref], tempDir);
  }

  const ref =
    parsed.ref ??
    (await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], tempDir))
      .stdout.trim();
  const directRelativePath =
    parsed.directRelativePath ??
    (await githubTreeSkillRelativePath(tempDir, parsed.path));

  return {
    directRelativePath: directRelativePath?.replace(/\/$/u, ""),
    ref,
    repoUrl: parsed.repoUrl.replace(/\.git$/u, ""),
    rootPath: tempDir,
    upstreamKind: "github",
  };
}

async function githubTreeSkillRelativePath(
  repoPath: string,
  path: string | undefined,
): Promise<string | undefined> {
  if (path === undefined) {
    return undefined;
  }

  if (!(await exists(join(repoPath, path, "SKILL.md")))) {
    return undefined;
  }

  return path;
}

async function acquireLocalRepoSource(
  source: string,
): Promise<LocalRepoSource | undefined> {
  const localPath = resolve(process.cwd(), source);
  if (!(await exists(localPath))) {
    return undefined;
  }

  const sourceStat = await stat(localPath);
  const gitCwd = sourceStat.isDirectory() ? localPath : dirname(localPath);
  const rootPath = await gitTopLevelPath(gitCwd);
  if (rootPath === undefined) {
    return undefined;
  }

  const resolvedSourcePath = await realpath(localPath);
  const directRelativePath = await localDirectSkillRelativePath(
    rootPath,
    resolvedSourcePath,
    sourceStat.isDirectory(),
  );
  const origin = await gitRemoteOrigin(rootPath);

  return {
    directRelativePath,
    origin,
    rootPath,
    upstreamKind: "local",
  };
}

async function localDirectSkillRelativePath(
  rootPath: string,
  sourcePath: string,
  sourceIsDirectory: boolean,
): Promise<string | undefined> {
  if (!sourceIsDirectory && basename(sourcePath) === "SKILL.md") {
    return normalizePath(relative(rootPath, dirname(sourcePath)));
  }

  if (
    sourceIsDirectory &&
    resolve(sourcePath) !== resolve(rootPath) &&
    (await exists(join(sourcePath, "SKILL.md")))
  ) {
    return normalizePath(relative(rootPath, sourcePath));
  }

  return undefined;
}

async function acquireGitFragmentSource(
  source: string,
): Promise<AcquiredSource | undefined> {
  const fragment = splitGitFragmentSource(source);
  if (fragment === undefined) {
    return undefined;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "jawfish-repo-"));
  await runCommand("git", ["clone", "--quiet", fragment.source, tempDir], process.cwd());
  const packagePath = join(tempDir, fragment.relativePath);
  return {
    inferredName: inferPackageName(packagePath),
    packagePath,
  };
}

function splitGitFragmentSource(source: string): GitFragmentSource | undefined {
  if (isUrl(source)) {
    return undefined;
  }

  const hashIndex = source.indexOf("#");
  if (hashIndex < 0) {
    return undefined;
  }

  const base = source.slice(0, hashIndex);
  const relativePath = source.slice(hashIndex + 1);
  if (base === "" || relativePath === "") {
    return undefined;
  }

  return { relativePath, source: base };
}

async function acquireLocalSource(source: string): Promise<AcquiredSource> {
  const localPath = resolve(process.cwd(), source);
  const sourceStat = await stat(localPath);
  const packagePath = sourceStat.isDirectory() ? localPath : dirname(localPath);
  return {
    entryFile: sourceStat.isDirectory() ? undefined : localPath,
    inferredName: inferPackageName(packagePath),
    packagePath,
  };
}

async function acquireUrlSource(source: string): Promise<AcquiredSource> {
  const tempDir = await mkdtemp(join(tmpdir(), "jawfish-source-"));
  const normalizedSource = normalizeSourceUrl(source);
  const url = new URL(normalizedSource);
  const fileName = basename(url.pathname) || "agentic.md";
  const sourceResponse = await fetchUrl(normalizedSource);

  if (isDirectoryListing(sourceResponse)) {
    await downloadUrlDirectory(normalizedSource, tempDir, sourceResponse.links);
    return {
      inferredName: inferUrlPackageName(url.pathname),
      packagePath: tempDir,
    };
  }

  const parentUrl = new URL(".", normalizedSource).toString();
  const parentResponse = await fetchUrl(parentUrl, false);
  const filePath = join(tempDir, fileName);

  if (parentResponse !== undefined && isDirectoryListing(parentResponse)) {
    await downloadUrlDirectory(parentUrl, tempDir, parentResponse.links);
  } else {
    await writeFile(filePath, sourceResponse.body);
  }

  return {
    entryFile: filePath,
    inferredName:
      inferUrlPackageName(dirname(url.pathname)) || inferPackageName(fileName),
    packagePath: tempDir,
  };
}

async function fetchUrl(source: string): Promise<UrlResponse>;
async function fetchUrl(
  source: string,
  throwOnMissing: false,
): Promise<UrlResponse | undefined>;
async function fetchUrl(
  source: string,
  throwOnMissing = true,
): Promise<UrlResponse | undefined> {
  const response = await fetch(source);
  if (!response.ok) {
    if (!throwOnMissing) {
      return undefined;
    }

    throw new Error(
      `Failed to fetch ${source}: ${response.status} ${response.statusText}`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  return {
    body,
    contentType,
    links: parseHtmlLinks(body.toString("utf8")),
  };
}

function parseGitHubSource(source: string): ParsedGitHubSource | undefined {
  if (!isUrl(source)) {
    return undefined;
  }

  const url = new URL(source);
  if (url.hostname === "raw.githubusercontent.com") {
    return parseRawGitHubSource(url);
  }

  if (url.hostname !== "github.com") {
    return undefined;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  const [owner, rawRepo, kind, ref, ...pathParts] = parts;
  if (owner === undefined || rawRepo === undefined) {
    return undefined;
  }

  const repo = rawRepo.replace(/\.git$/u, "");
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  if (kind === undefined) {
    return { repoUrl };
  }

  if ((kind === "tree" || kind === "blob") && ref !== undefined) {
    const path = normalizePath(pathParts.join("/"));
    return {
      directRelativePath: githubBlobSkillRelativePath(kind, path),
      path,
      ref,
      repoUrl,
    };
  }

  return undefined;
}

function parseRawGitHubSource(url: URL): ParsedGitHubSource | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) {
    return undefined;
  }

  const [owner, repo, ref, ...pathParts] = parts;
  if (owner === undefined || repo === undefined || ref === undefined) {
    return undefined;
  }

  const path = normalizePath(pathParts.join("/"));
  return {
    directRelativePath: skillFileParentPath(path),
    path,
    ref,
    repoUrl: `https://github.com/${owner}/${repo.replace(/\.git$/u, "")}.git`,
  };
}

function githubBlobSkillRelativePath(
  kind: string,
  path: string,
): string | undefined {
  return kind === "blob" ? skillFileParentPath(path) : undefined;
}

function skillFileParentPath(path: string): string | undefined {
  if (basename(path) !== "SKILL.md") {
    return undefined;
  }

  return normalizePath(dirname(path));
}

function githubTreeUrl(repoUrl: string, ref: string, relativePath: string): string {
  const cleanRepoUrl = repoUrl.replace(/\.git$/u, "");
  const cleanRelativePath = relativePath === "." ? "" : `/${relativePath}`;
  return `${cleanRepoUrl}/tree/${ref}${cleanRelativePath}`;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isDirectoryListing(response: UrlResponse): boolean {
  return (
    response.contentType.includes("text/html") && response.links.length > 0
  );
}

async function downloadUrlDirectory(
  source: string,
  destination: string,
  directoryLinks?: string[],
): Promise<void> {
  const directoryUrl = source.endsWith("/") ? source : `${source}/`;
  const links = directoryLinks ?? (await fetchUrl(directoryUrl)).links;

  await mkdir(destination, { recursive: true });

  for (const link of links) {
    const childUrl = new URL(link, directoryUrl);
    if (!isImportableChildUrl(childUrl, directoryUrl)) {
      continue;
    }

    const childName = basename(childUrl.pathname.replace(/\/$/u, ""));
    if (childName === "") {
      continue;
    }

    const childResponse = await fetchUrl(childUrl.toString());
    const childDestination = join(destination, childName);
    if (isDirectoryListing(childResponse)) {
      await downloadUrlDirectory(
        childUrl.toString(),
        childDestination,
        childResponse.links,
      );
      continue;
    }

    await writeFile(childDestination, childResponse.body);
  }
}

function parseHtmlLinks(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter(
      (href) => href !== "" && !href.startsWith("#") && !href.startsWith("?"),
    );
}

function isImportableChildUrl(childUrl: URL, parentUrl: string): boolean {
  const parent = new URL(parentUrl);
  return (
    childUrl.origin === parent.origin &&
    childUrl.pathname !== parent.pathname &&
    childUrl.pathname.startsWith(parent.pathname) &&
    !childUrl.pathname.includes("..")
  );
}

function inferUrlPackageName(pathname: string): string {
  return basename(pathname.replace(/\/$/u, ""));
}

function inferPackageName(packagePath: string): string {
  return basename(packagePath).replace(/\.[^.]+$/, "");
}

async function dirtyPaths(
  agenticsRepoDir: string,
  packagePath: string,
): Promise<string[]> {
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    return [];
  }

  const result = await runCommand(
    "git",
    ["status", "--porcelain", "--", packagePath],
    agenticsRepoDir,
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}
