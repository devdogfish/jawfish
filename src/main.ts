#!/usr/bin/env -S node --experimental-strip-types
import { cancel, isCancel, multiselect, select } from "@clack/prompts";
import {
  cp,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSupportedTools,
  loadConfig,
  saveConfig,
  type JawfishConfig,
} from "./config.ts";
import { exists } from "./files.ts";
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
import {
  acquireRepoSource,
  acquireSource,
  assertRepoSkillSelection,
  automaticRepoSkillSelection,
  catalogNameForUpstream,
  isDirectRepoSkillSource,
  isImportSource,
  isSameUpstream,
  planRepoSkillIntake,
  preparePackageUpdate,
  repoSkillCandidatesByRelativePath,
  shouldScanRepoSkills,
  unselectedRepoSiblingCount,
  type PackageUpdate,
  type RepoSkillCandidate,
  type RepoSkillIntakePlan,
  type RepoSource,
} from "./source-intake.ts";

const version = "0.1.4";

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
  const plan = await planRepoSkillIntake(catalog, repoSource);
  if (plan.candidates.length === 0) {
    throw new Error(`No skills found in repository source: ${repoSource.rootPath}`);
  }

  if (!isDirectRepoSkillSource(repoSource)) {
    printRepoSkillCandidates(plan.candidates);
  }
  const selectedCandidates = await selectRepoSkillCandidates(
    plan,
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
      plan,
      selectedCandidates,
      repoSource,
    ),
  };
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

function printRepoSkillCandidates(candidates: RepoSkillCandidate[]): void {
  console.log("Discovered repo skills");
  for (const candidate of candidates) {
    console.log(
      `${candidate.name} (${candidate.relativePath}) ${candidate.state} upstream: ${candidate.upstream}`,
    );
  }
}

async function selectRepoSkillCandidates(
  plan: RepoSkillIntakePlan,
  yes: boolean,
): Promise<RepoSkillCandidate[]> {
  const automaticSelection = automaticRepoSkillSelection(plan, yes);
  if (automaticSelection !== undefined) {
    return automaticSelection;
  }

  const selected = await multiselect({
    message: "Select repo skills",
    options: plan.candidates.map((candidate) => ({
      hint: candidate.upstream,
      label: repoSkillSelectionLabel(candidate),
      value: candidate.relativePath,
    })),
    initialValues: plan.initialRelativePaths,
    required: false,
  });

  if (isCancel(selected)) {
    cancel("Repo skill selection cancelled");
    throw new Error("Repo skill selection cancelled");
  }

  return repoSkillCandidatesByRelativePath(plan, selected);
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

function getScope(args: CommandArgs): InstallScope {
  return args.global ? "global" : "project";
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
