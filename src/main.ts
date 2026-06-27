#!/usr/bin/env -S node --experimental-strip-types
import { cancel, isCancel, multiselect, select } from "@clack/prompts";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSupportedTools,
  loadConfig,
  saveConfig,
  type JawfishConfig,
} from "./config.ts";
import { exists } from "./files.ts";
import { gitRemoteOrigin, gitTopLevelPath } from "./git-source.ts";
import { initCommand } from "./init-command.ts";
import {
  assertCanMaterializePackage,
  installManifestEntry,
  materialize,
  readManifest,
  removeMaterialized,
  resolveInside,
  stripMaterializationMetadata,
  writeManifest,
  type ManifestEntry,
} from "./install.ts";
import { runCommand } from "./process.ts";
import {
  openAgenticsRepoSession,
  type AgenticsRepoSession,
} from "./agentics-repo.ts";
import {
  agenticTypes,
  isAgenticType,
  type Catalog,
  type CatalogEntry,
} from "./catalog.ts";
import {
  assertSupportedTool,
  typeFolder,
  type AgenticType,
  type InstallScope,
} from "./tool-adapters.ts";
import {
  applySkillImport,
  type DiscoveredSkill,
  globalSkillRoot,
  planSkillImport,
  printImportSkillsPlan,
} from "./provider-skill-import.ts";
import {
  formatCommandHelp,
  formatRootHelp,
  parseCommand,
  type CommandArgs,
} from "./command-grammar.ts";
import { queryListCatalog } from "./list-query.ts";
import { formatListRawJson, formatListTable } from "./list-format.ts";
import {
  bulkUpdateResult,
  formatUpdateDiagnostics,
  formatUpdateResult,
  updateFailure,
  updateResultExitCode,
  updatedPackageResult,
  type BulkUpdateSummary,
  type UpdateResult,
} from "./update-result.ts";

const version = "0.1.4";

interface AcquiredSource {
  entryFile?: string;
  inferredName: string;
  packagePath: string;
}

interface GitHubRepoSource {
  directRelativePath?: string;
  ref?: string;
  repoUrl: string;
  rootPath: string;
  upstreamKind: "github";
}

interface LocalRepoSource {
  directRelativePath?: string;
  origin?: string;
  rootPath: string;
  upstreamKind: "local";
}

type RepoSource = GitHubRepoSource | LocalRepoSource;

interface RepoSkillCandidate {
  catalogName: string;
  conflict: boolean;
  existing: boolean;
  name: string;
  relativePath: string;
  sourcePath: string;
  upstream: string;
}

interface RepoSkillSelection {
  imported: boolean;
  name: string;
}

interface RepoSkillImportResult {
  selected: RepoSkillSelection[];
  unselectedSiblingCount: number;
}

interface ImportPackageResult {
  imported: boolean;
  name: string;
}

interface PackageUpdate {
  catalogEntry: CatalogEntry;
  sourcePath: string;
}

export async function promptForTool(tools: readonly string[]): Promise<string> {
  const selected = await select({
    message: "Select default tool",
    options: tools.map((tool) => ({ label: tool, value: tool })),
  });

  if (isCancel(selected)) {
    cancel("No tool selected");
    process.exitCode = 1;
    return "";
  }

  return selected;
}

export async function promptForAgenticType(
  packagePath: string,
): Promise<AgenticType> {
  const selected = await select({
    message: `Select agentic type for ${packagePath}`,
    options: agenticTypes.map((type) => ({ label: type, value: type })),
  });

  if (isCancel(selected)) {
    cancel("No agentic type selected");
    throw new Error("No agentic type selected");
  }

  return selected;
}

export async function run(argv: string[]): Promise<number> {
  try {
    const request = parseCommand(argv);

    switch (request.kind) {
      case "root-help":
        console.log(formatRootHelp(version));
        return 0;
      case "version":
        console.log(version);
        return 0;
      case "command-help":
        console.log(formatCommandHelp(request.command));
        return 0;
      case "dispatch":
        break;
    }

    switch (request.handler) {
      case "add":
        return await addCommand(request.args);
      case "init":
        return await initCommand(request.args);
      case "install":
        return await installCommand(request.args);
      case "import-skills":
        return await importSkillsCommand(request.args);
      case "list":
        return await listCommand(request.args);
      case "remove":
        return await removeCommand(request.args);
      case "update":
        return await updateCommand(request.args);
      case "upgrade":
        return await upgradeCommand(request.args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function addCommand(args: CommandArgs): Promise<number> {
  const source = args.positionals[0]!;

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const session = await openAgenticsRepoSession(config);
  const catalog = await session.readCatalog();
  const scope = getScope(args);

  if (catalogHasAgentic(catalog, source)) {
    const tool = await installOne(session.dir, catalog, source, scope, config);
    console.log(`Added ${source} to ${scope}`);
    printCatalogEntry(source, catalog.jawfish[source], tool);
    return 0;
  }

  if (!(await isImportSource(source))) {
    throw new Error(`Unknown agentic: ${source}`);
  }

  const repoSource = await acquireRepoSource(source);
  if (repoSource !== undefined && shouldScanRepoSkills(repoSource, config)) {
    const result = await importAndInstallRepoSkills(
      session,
      catalog,
      repoSource,
      args,
      scope,
      config,
    );
    if (result.selected.length > 0) {
      console.log(
        `Added ${result.selected.map((item) => item.name).join(", ")} to ${scope}`,
      );
      if (result.unselectedSiblingCount > 0) {
        console.log(
          `Also found ${formatRepoSkillCount(result.unselectedSiblingCount)}. Run jawfish add <repo> to choose them.`,
        );
      }
    }
    return 0;
  }

  const imported = await importPackage(session.dir, catalog, source, args.name);
  if (imported.imported) {
    await session.writeCatalog(catalog);
    if (!(await session.pushChanges(`add ${imported.name}`))) {
      return 1;
    }
  }

  await installOne(session.dir, catalog, imported.name, scope, config);
  console.log(`Added ${imported.name} to ${scope}`);
  return 0;
}

async function installCommand(args: CommandArgs): Promise<number> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const session = await openAgenticsRepoSession(config);
  await session.sync();
  const catalog = await session.readCatalog();
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const installPlan = Object.entries(manifest.jawfish).map(([name, entry]) => {
    const tool = entry.tool;
    assertSupportedTool(tool, `manifest entry "${name}"`);
    if (!catalogHasAgentic(catalog, name)) {
      throw new Error(`Unknown agentic: ${name}`);
    }

    return { name, tool };
  });

  for (const { name, tool } of installPlan) {
    await materialize(session.dir, catalog, name, scope, tool);
  }

  console.log(`Installed ${installPlan.length} jawfish to ${scope}`);
  return 0;
}

async function listCommand(args: CommandArgs): Promise<number> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const session = await openAgenticsRepoSession(config);
  await session.sync();
  const catalog = await session.readCatalog();
  const [projectManifest, globalManifest] = await Promise.all([
    readManifest("project"),
    readManifest("global"),
  ]);

  const result = queryListCatalog({
    agenticsRepoDir: session.dir,
    catalog,
    globalManifest,
    installed: args.installed,
    projectManifest,
    type: args.type,
  });

  if (args.raw) {
    console.log(formatListRawJson(result));
    return 0;
  }

  console.log(formatListTable(result));
  return 0;
}

async function importSkillsCommand(args: CommandArgs): Promise<number> {
  const provider = args.positionals[0]!;

  assertSupportedTool(provider, "provider");

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const session = await openAgenticsRepoSession(config);
  const catalog = await session.readCatalog();
  const sourceRoot = globalSkillRoot(provider);
  const plan = await planSkillImport(sourceRoot, catalog);

  printImportSkillsPlan(provider, sourceRoot, plan);

  if (plan.imported.length === 0) {
    console.log("No importable skills found");
    return 0;
  }

  const selected = args.yes
    ? plan.imported
    : await selectProviderSkillsForImport(plan.imported);

  if (selected.length === 0) {
    console.log("No skills selected for import");
    return 0;
  }

  await applySkillImport(session.dir, catalog, provider, selected);
  await session.writeCatalog(catalog);
  if (!(await session.pushChanges(`import skills from ${provider}`))) {
    return 1;
  }

  console.log(`Imported ${selected.length} skills from ${provider}`);
  return 0;
}

async function upgradeCommand(args: CommandArgs): Promise<number> {
  console.log("Upgrading jawfish with bun...");
  const result = await runCommand(
    "bun",
    ["update", "-g", "jawfish", "--latest"],
    process.cwd(),
    false,
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode === 0 ? 0 : 1;
}

async function removeCommand(args: CommandArgs): Promise<number> {
  const name = args.positionals[0]!;

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const session = await openAgenticsRepoSession(config);
  const catalog = await session.readCatalog();
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const manifestEntry = manifest.jawfish[name];
  const catalogEntry = catalog.jawfish[name];

  if (manifestEntry === undefined) {
    console.error(`Not installed in ${scope}: ${name}`);
    return 1;
  }

  if (catalogEntry !== undefined) {
    assertSupportedTool(
      manifestEntry.tool,
      `manifest entry "${name}"`,
    );
    await removeMaterialized(
      name,
      catalogEntry.type,
      scope,
      manifestEntry.tool,
    );
  }

  delete manifest.jawfish[name];
  await writeManifest(scope, manifest);
  console.log(`Removed ${name} from ${scope}`);
  return 0;
}

async function updateCommand(args: CommandArgs): Promise<number> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const session = await openAgenticsRepoSession(config);
  await session.sync();
  const catalog = await session.readCatalog();
  const name = args.positionals[0];
  const reinstallScope = getScope(args);

  if (name !== undefined) {
    await updatePackageInAgenticsRepo(
      session.dir,
      catalog,
      name,
      args.force,
      reinstallScope,
    );
    await session.writeCatalog(catalog);
    if (!(await session.pushChanges(`update ${name}`))) {
      return 1;
    }

    await reinstallInScopeIfPresent(
      session.dir,
      catalog,
      name,
      reinstallScope,
    );
    printUpdateResult(updatedPackageResult(name));
    return 0;
  }

  const summary = await updateAllPackages(
    session.dir,
    catalog,
    args.force,
    reinstallScope,
  );
  const result = bulkUpdateResult(summary);

  if (summary.failed.length === 0 && summary.updated.length > 0) {
    await session.writeCatalog(catalog);
    if (!(await session.pushChanges("update jawfish"))) {
      printUpdateResult(result);
      return 1;
    }

    await Promise.all(
      summary.updated.map((updatedName) =>
        reinstallInScopeIfPresent(
          session.dir,
          catalog,
          updatedName,
          reinstallScope,
        ),
      ),
    );
  }

  printUpdateResult(result);
  return updateResultExitCode(result);
}

async function installOne(
  agenticsRepoDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  config: JawfishConfig,
): Promise<string> {
  const tool = await resolveTool(config);
  await installManifestEntry(agenticsRepoDir, catalog, name, scope, tool);
  return tool;
}

async function importPackage(
  agenticsRepoDir: string,
  catalog: Catalog,
  source: string,
  nameOverride: string | undefined,
): Promise<ImportPackageResult> {
  const existingName = catalogNameForUpstream(catalog, source);
  if (existingName !== undefined) {
    return { imported: false, name: existingName };
  }

  const acquired = await acquireSource(source);
  const name = nameOverride ?? acquired.inferredName;

  if (catalogHasAgentic(catalog, name)) {
    const existing = catalog.jawfish[name];
    if (existing !== undefined && isSameUpstream(existing.upstream, source)) {
      return { imported: false, name };
    }

    throw new Error(`Agentic already exists in catalog: ${name}`);
  }

  const type = await inferType(acquired.packagePath, acquired.entryFile);
  const packagePath = join(typeFolder(type), name);
  const destination = resolveInside(agenticsRepoDir, packagePath);

  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(acquired.packagePath, destination, { recursive: true });
  await stripMaterializationMetadata(destination);

  catalog.jawfish[name] = {
    description: "",
    path: packagePath,
    type,
    upstream: source,
  };

  return { imported: true, name };
}

async function importAndInstallRepoSkills(
  session: AgenticsRepoSession,
  catalog: Catalog,
  repoSource: RepoSource,
  args: CommandArgs,
  scope: InstallScope,
  config: JawfishConfig,
): Promise<RepoSkillImportResult> {
  const candidates = await repoSkillCandidates(catalog, repoSource);
  if (candidates.length === 0) {
    throw new Error(`No skills found in repository source: ${repoSource.rootPath}`);
  }

  if (!isDirectRepoSkillSource(repoSource)) {
    printRepoSkillCandidates(candidates);
  }
  const selectedCandidates = await selectRepoSkillCandidates(
    candidates,
    repoSource,
    args.yes,
  );
  if (selectedCandidates.length === 0) {
    console.log("No repo skills selected");
    return { selected: [], unselectedSiblingCount: 0 };
  }

  assertRepoSkillSelection(selectedCandidates);

  const selections: RepoSkillSelection[] = [];
  let importedCount = 0;
  for (const candidate of selectedCandidates) {
    const imported = await importRepoSkillCandidate(
      session.dir,
      catalog,
      candidate,
      args.name,
      selectedCandidates.length,
    );
    if (imported.imported) {
      importedCount += 1;
    }
    selections.push(imported);
  }

  if (importedCount > 0) {
    await session.writeCatalog(catalog);
    const names = selections.map((selection) => selection.name).join(", ");
    if (!(await session.pushChanges(`add ${names}`))) {
      return { selected: [], unselectedSiblingCount: 0 };
    }
  }

  for (const selection of selections) {
    await installOne(session.dir, catalog, selection.name, scope, config);
  }

  return {
    selected: selections,
    unselectedSiblingCount: unselectedRepoSiblingCount(
      candidates,
      selectedCandidates,
      repoSource,
    ),
  };
}

function shouldScanRepoSkills(
  repoSource: RepoSource,
  config: JawfishConfig,
): boolean {
  if (!isDirectRepoSkillSource(repoSource)) {
    return true;
  }

  return config.autoScanRepoSkills !== false;
}

function unselectedRepoSiblingCount(
  candidates: RepoSkillCandidate[],
  selectedCandidates: RepoSkillCandidate[],
  repoSource: RepoSource,
): number {
  if (!isDirectRepoSkillSource(repoSource)) {
    return 0;
  }

  const selectedPaths = new Set(
    selectedCandidates.map((candidate) => candidate.relativePath),
  );
  return candidates.filter(
    (candidate) =>
      candidate.relativePath !== repoSource.directRelativePath &&
      !selectedPaths.has(candidate.relativePath),
  ).length;
}

function isDirectRepoSkillSource(repoSource: RepoSource): boolean {
  return repoSource.directRelativePath !== undefined;
}

function formatRepoSkillCount(count: number): string {
  return `${count} repo ${count === 1 ? "skill" : "skills"}`;
}

async function importRepoSkillCandidate(
  agenticsRepoDir: string,
  catalog: Catalog,
  candidate: RepoSkillCandidate,
  nameOverride: string | undefined,
  selectionCount: number,
): Promise<RepoSkillSelection> {
  if (candidate.existing) {
    return { imported: false, name: candidate.catalogName };
  }

  if (nameOverride !== undefined && selectionCount !== 1) {
    throw new Error("--name can only be used when one repo skill is selected");
  }

  const name = nameOverride ?? candidate.name;
  const packagePath = join(typeFolder("skill"), name);
  const destination = resolveInside(agenticsRepoDir, packagePath);

  if (catalogHasAgentic(catalog, name)) {
    const existing = catalog.jawfish[name];
    if (existing !== undefined && isSameUpstream(existing.upstream, candidate.upstream)) {
      return { imported: false, name };
    }

    throw new Error(`Agentic already exists in catalog: ${name}`);
  }

  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(candidate.sourcePath, destination, { recursive: true });
  await stripMaterializationMetadata(destination);

  catalog.jawfish[name] = {
    description: "",
    path: packagePath,
    type: "skill",
    upstream: candidate.upstream,
  };

  return { imported: true, name };
}

async function repoSkillCandidates(
  catalog: Catalog,
  repoSource: RepoSource,
): Promise<RepoSkillCandidate[]> {
  const skillDirs = await findSkillDirectories(repoSource.rootPath);
  const candidates = skillDirs.map((sourcePath) =>
    repoSkillCandidate(catalog, repoSource, sourcePath),
  );

  return candidates.sort((left, right) => left.name.localeCompare(right.name));
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

  return {
    catalogName: existingName ?? name,
    conflict,
    existing,
    name,
    relativePath,
    sourcePath,
    upstream,
  };
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

function printRepoSkillCandidates(candidates: RepoSkillCandidate[]): void {
  console.log("Discovered repo skills");
  for (const candidate of candidates) {
    const state = repoSkillCandidateState(candidate);
    console.log(
      `${candidate.name} (${candidate.relativePath}) ${state} upstream: ${candidate.upstream}`,
    );
  }
}

function repoSkillCandidateState(candidate: RepoSkillCandidate): string {
  if (candidate.conflict) {
    return "conflict";
  }

  if (candidate.existing) {
    return "existing";
  }

  return "new";
}

async function selectRepoSkillCandidates(
  candidates: RepoSkillCandidate[],
  repoSource: RepoSource,
  yes: boolean,
): Promise<RepoSkillCandidate[]> {
  const direct = directRepoSkillCandidate(candidates, repoSource);
  if (direct !== undefined) {
    return [direct];
  }

  if (yes) {
    return candidates.filter((candidate) => !candidate.conflict);
  }

  const initialValues = repoSkillInitialSelections(candidates, direct);

  const selected = await multiselect({
    message: "Select repo skills",
    options: candidates.map((candidate) => ({
      hint: candidate.upstream,
      label: repoSkillSelectionLabel(candidate),
      value: candidate.relativePath,
    })),
    initialValues,
    required: false,
  });

  if (isCancel(selected)) {
    cancel("Repo skill selection cancelled");
    throw new Error("Repo skill selection cancelled");
  }

  const selectedPaths = new Set(selected);
  return candidates.filter((candidate) => selectedPaths.has(candidate.relativePath));
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

function repoSkillSelectionLabel(candidate: RepoSkillCandidate): string {
  return `${candidate.name} (${candidate.relativePath})${repoSkillSelectionSuffix(candidate)}`;
}

function repoSkillSelectionSuffix(candidate: RepoSkillCandidate): string {
  if (candidate.conflict) {
    return " conflict";
  }

  if (candidate.existing) {
    return " existing";
  }

  return "";
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

function assertRepoSkillSelection(candidates: RepoSkillCandidate[]): void {
  const conflicts = candidates
    .filter((candidate) => candidate.conflict)
    .map((candidate) => candidate.name);
  if (conflicts.length > 0) {
    throw new Error(
      `Repo skill name conflicts: ${conflicts.join(", ")}`,
    );
  }
}

function catalogNameForUpstream(
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

function isSameUpstream(existing: string | undefined, source: string): boolean {
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

async function selectProviderSkillsForImport(
  skills: DiscoveredSkill[],
): Promise<DiscoveredSkill[]> {
  const selected = await multiselect({
    message: "Import existing skills",
    options: skills.map((skill) => ({
      hint: skill.path,
      label: skill.name,
      value: skill.name,
    })),
    required: false,
  });

  if (isCancel(selected)) {
    cancel("Import cancelled");
    throw new Error("Import cancelled");
  }

  const selectedNames = new Set(selected);
  return skills.filter((skill) => selectedNames.has(skill.name));
}

async function acquireSource(source: string): Promise<AcquiredSource> {
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

async function isImportSource(source: string): Promise<boolean> {
  if (isUrl(source)) {
    return true;
  }

  const fragment = splitGitFragmentSource(source);
  if (fragment !== undefined) {
    return exists(resolve(process.cwd(), fragment.source));
  }

  return exists(resolve(process.cwd(), source));
}

async function acquireRepoSource(source: string): Promise<RepoSource | undefined> {
  const github = parseGitHubSource(source);
  if (github !== undefined) {
    return acquireGitHubRepoSource(github);
  }

  return acquireLocalRepoSource(source);
}

interface ParsedGitHubSource {
  directRelativePath?: string;
  path?: string;
  ref?: string;
  repoUrl: string;
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

interface GitFragmentSource {
  relativePath: string;
  source: string;
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

interface UrlResponse {
  body: Buffer;
  contentType: string;
  links: string[];
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

async function preparePackageUpdate(
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

async function updatePackageInAgenticsRepo(
  agenticsRepoDir: string,
  catalog: Catalog,
  name: string,
  force: boolean,
  reinstallScope: InstallScope,
): Promise<void> {
  const update = await preparePackageUpdate(agenticsRepoDir, catalog, name, force);
  await assertCanReinstallInScopeIfPresent(
    update.sourcePath,
    update.catalogEntry,
    name,
    reinstallScope,
  );
  await applyPackageUpdate(agenticsRepoDir, update);
}

async function applyPackageUpdate(
  agenticsRepoDir: string,
  update: PackageUpdate,
): Promise<void> {
  const destination = resolveInside(agenticsRepoDir, update.catalogEntry.path);
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(update.sourcePath, destination, { recursive: true });
}

async function assertCanReinstallInScopeIfPresent(
  packagePath: string,
  catalogEntry: CatalogEntry,
  name: string,
  scope: InstallScope,
): Promise<void> {
  const entry = await installedManifestEntry(scope, name);
  if (entry === undefined) {
    return;
  }

  await assertCanMaterializePackage(
    packagePath,
    name,
    catalogEntry.type,
    scope,
    entry.tool,
  );
}

async function updateAllPackages(
  agenticsRepoDir: string,
  catalog: Catalog,
  force: boolean,
  reinstallScope: InstallScope,
): Promise<BulkUpdateSummary> {
  const summary: BulkUpdateSummary = { failed: [], skipped: [], updated: [] };

  for (const name of Object.keys(catalog.jawfish)) {
    const entry = catalog.jawfish[name];
    if (entry.upstream === undefined) {
      summary.skipped.push(name);
      continue;
    }

    try {
      await updatePackageInAgenticsRepo(
        agenticsRepoDir,
        catalog,
        name,
        force,
        reinstallScope,
      );
      summary.updated.push(name);
    } catch (error) {
      summary.failed.push(updateFailure(name, error));
    }
  }

  return summary;
}

function printUpdateResult(result: UpdateResult): void {
  const diagnostics = formatUpdateDiagnostics(result);
  if (diagnostics !== "") {
    console.error(diagnostics);
  }
  console.log(formatUpdateResult(result));
}

async function reinstallInScopeIfPresent(
  agenticsRepoDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
): Promise<void> {
  const entry = await installedManifestEntry(scope, name);
  if (entry !== undefined) {
    await materialize(agenticsRepoDir, catalog, name, scope, entry.tool);
  }
}

async function installedManifestEntry(
  scope: InstallScope,
  name: string,
): Promise<ManifestEntry | undefined> {
  const manifest = await readManifest(scope);
  const entry = manifest.jawfish[name];
  if (entry !== undefined) {
    assertSupportedTool(entry.tool, `manifest entry "${name}"`);
  }

  return entry;
}

async function resolveTool(config: JawfishConfig): Promise<string> {
  if (config.defaultTool !== undefined) {
    assertSupportedTool(config.defaultTool, "config defaultTool");
    return config.defaultTool;
  }

  const selected = await promptForTool(defaultSupportedTools);
  if (selected === "") {
    throw new Error("No default tool selected");
  }

  assertSupportedTool(selected, "selected default tool");
  config.defaultTool = selected;
  await saveConfig(config);
  return selected;
}

function printCatalogEntry(
  name: string,
  entry: CatalogEntry | undefined,
  tool: string,
): void {
  if (entry === undefined) {
    return;
  }

  console.log(`${name} (${entry.type})`);
  console.log(entry.description);
  console.log(`tool: ${tool}`);
  console.log(`path: ${entry.path}`);

  if (entry.upstream !== undefined) {
    console.log(`upstream: ${entry.upstream}`);
  }
}

async function inferType(
  packagePath: string,
  entryFile: string | undefined,
): Promise<AgenticType> {
  const skillPath = join(packagePath, "SKILL.md");
  const agentPath = join(packagePath, "AGENT.md");
  const detectedTypes: AgenticType[] = [];

  if (await exists(skillPath)) {
    detectedTypes.push("skill");
  }

  if (await exists(agentPath)) {
    detectedTypes.push("agent");
  }

  if (
    detectedTypes.length === 0 &&
    (await hasPromptSignal(packagePath, entryFile))
  ) {
    detectedTypes.push("prompt");
  }

  if (detectedTypes.length === 1) {
    return detectedTypes[0];
  }

  const envImportType = process.env.JAWFISH_IMPORT_TYPE;
  if (envImportType !== undefined) {
    if (isAgenticType(envImportType)) {
      return envImportType;
    }

    throw new Error(`Invalid JAWFISH_IMPORT_TYPE: ${envImportType}`);
  }

  return promptForAgenticType(packagePath);
}

async function hasPromptSignal(
  packagePath: string,
  entryFile: string | undefined,
): Promise<boolean> {
  if (entryFile !== undefined && promptExtensions.has(extname(entryFile))) {
    return true;
  }

  const entries = await readdir(packagePath, { withFileTypes: true });
  const promptFiles = entries.filter((entry) => {
    return entry.isFile() && promptExtensions.has(extname(entry.name));
  });

  return promptFiles.length === 1;
}

function inferPackageName(packagePath: string): string {
  return basename(packagePath).replace(/\.[^.]+$/, "");
}

function getScope(args: CommandArgs): InstallScope {
  return args.global ? "global" : "project";
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

const promptExtensions = new Set([".md", ".txt", ".prompt"]);

function catalogHasAgentic(catalog: Catalog, name: string): boolean {
  return Object.hasOwn(catalog.jawfish, name);
}

async function isMainModule(): Promise<boolean> {
  if (process.argv[1] === undefined) {
    return false;
  }

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const argvPath = await realpath(process.argv[1]);

  return modulePath === argvPath;
}


if (await isMainModule()) {
  process.exitCode = await run(process.argv.slice(2));
}
