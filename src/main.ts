#!/usr/bin/env -S node --experimental-strip-types
import { cancel, confirm, isCancel, select } from "@clack/prompts";
import { spawn } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSupportedConfiguredTool,
  configPath,
  defaultSupportedTools,
  deprecatedLibraryPath,
  loadConfig,
  managedLibraryPath,
  manifestPath,
  saveConfig,
  toolPaths,
  type JawfishConfig,
} from "./config.ts";
import {
  destinationSpec,
  typeFolder,
  type AgenticType,
  type DestinationSpec,
  type InstallScope,
} from "./tool-adapters.ts";

const version = "0.1.2";
const catalogFile = "catalog.json";
const indexCatalogFile = "index.json";
const managedMarkerFile = ".jawfish-managed.json";
const libraryIgnoreEntries = ["config.json", "jawfish.json"];
const agenticTypes = [
  "skill",
  "agent",
  "prompt",
] as const satisfies readonly AgenticType[];

interface CommandSpec {
  description: string;
  summary: string;
  usage: string;
  options: string[];
}

interface Catalog {
  jawfish: Record<string, CatalogEntry>;
}

interface CatalogEntry {
  description: string;
  path: string;
  type: AgenticType;
  upstream?: string;
}

interface Manifest {
  jawfish: Record<string, ManifestEntry>;
}

interface ManifestEntry {
  tool: string;
}

interface ManagedMarker {
  files?: string[];
  name: string;
  tool: string;
  type: AgenticType;
}

interface ParsedArgs {
  force: boolean;
  global: boolean;
  help: boolean;
  installed?: string;
  name?: string;
  positionals: string[];
  raw: boolean;
  type?: string;
  yes: boolean;
}

interface CommandResult {
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

interface AcquiredSource {
  entryFile?: string;
  inferredName: string;
  packagePath: string;
}

type PushResult = { ok: true } | { ok: false; error: string };

interface BulkUpdateFailure {
  details: string;
  message: string;
  name: string;
}

interface BulkUpdateSummary {
  failed: BulkUpdateFailure[];
  skipped: string[];
  updated: string[];
}

interface DiscoveredSkill {
  name: string;
  path: string;
}

interface ImportSkillsPlan {
  conflicts: string[];
  imported: DiscoveredSkill[];
  skipped: ImportSkillsSkip[];
}

interface ImportSkillsSkip {
  name: string;
  reason: string;
}

interface ImportPackageResult {
  imported: boolean;
  name: string;
}

const commandSpecs = {
  add: {
    description:
      "Install an agentic from the library, or import a URL/local path.",
    summary: "Install or import an agentic",
    usage: "jawfish add [options] <name|source>",
    options: [
      "-g, --global    Install globally",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
  },
  init: {
    description: "Initialize jawfish config and content library.",
    summary: "Initialize jawfish",
    usage: "jawfish init [content-library]",
    options: ["-h, --help      Show help"],
  },
  install: {
    description:
      "Install an agentic when a name/source is provided, otherwise materialize manifest jawfish.",
    summary: "Install an agentic or manifest",
    usage: "jawfish install [options] [name|source]",
    options: [
      "-g, --global    Install global manifest",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
  },
  i: {
    description:
      "Alias for install: add a name/source, or materialize the manifest with no name/source.",
    summary: "Alias for install",
    usage: "jawfish i [options] [name|source]",
    options: [
      "-g, --global    Install global manifest",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
  },
  "import-skills": {
    description: "Import existing global skills from a supported tool.",
    summary: "Import global provider skills",
    usage: "jawfish import-skills [options] <provider>",
    options: [
      "-y, --yes      Import without prompting",
      "-h, --help     Show help",
    ],
  },
  list: {
    description: "List available jawfish in the content library.",
    summary: "List available jawfish",
    usage: "jawfish list [options]",
    options: [
      "--type <type>           Filter by skill, agent, or prompt",
      "--installed <status>    Filter by project, global, both, none, or any",
      "--raw                   Print JSON",
      "-h, --help              Show help",
    ],
  },
  update: {
    description: "Refresh one or all upstream-backed jawfish.",
    summary: "Update upstream-backed jawfish",
    usage: "jawfish update [options] [name]",
    options: [
      "-g, --global    Reinstall global manifest if already installed",
      "-F, --force     Replace dirty package contents",
      "-h, --help      Show help",
    ],
  },
  upgrade: {
    description: "Upgrade the jawfish CLI itself.",
    summary: "Upgrade jawfish itself",
    usage: "jawfish upgrade",
    options: ["-h, --help      Show help"],
  },
  remove: {
    description: "Remove installed managed jawfish.",
    summary: "Remove installed jawfish",
    usage: "jawfish remove [options] <name>",
    options: [
      "-g, --global    Remove global install",
      "-h, --help      Show help",
    ],
  },
} as const satisfies Record<string, CommandSpec>;

type CommandName = keyof typeof commandSpecs;
const commandNames = Object.keys(commandSpecs) as CommandName[];

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
  const [command, ...args] = argv;

  try {
    if (command === undefined || isHelp(command)) {
      printRootHelp();
      return 0;
    }

    if (command === "--version" || command === "-v") {
      console.log(version);
      return 0;
    }

    if (!isCommandName(command)) {
      console.error(`Unknown command: ${command}`);
      console.error("Run jawfish --help for usage.");
      return 1;
    }

    const parsed = parseArgs(args, command);
    if (parsed.help) {
      printCommandHelp(command);
      return 0;
    }

    switch (command) {
      case "add":
        return await addCommand(parsed);
      case "init":
        return await initCommand(parsed);
      case "i":
        return parsed.positionals.length > 0
          ? await addCommand(parsed)
          : await installCommand(parsed);
      case "install":
        return parsed.positionals.length > 0
          ? await addCommand(parsed)
          : await installCommand(parsed);
      case "import-skills":
        return await importSkillsCommand(parsed);
      case "list":
        return await listCommand(parsed);
      case "remove":
        return await removeCommand(parsed);
      case "update":
        return await updateCommand(parsed);
      case "upgrade":
        return await upgradeCommand(parsed);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function addCommand(args: ParsedArgs): Promise<number> {
  const source = args.positionals[0];
  if (source === undefined) {
    console.error("Usage: jawfish add [options] <name|source>");
    return 1;
  }

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const libraryDir = await resolveContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);

  if (catalogHasAgentic(catalog, source)) {
    const tool = await installOne(libraryDir, catalog, source, scope, config);
    console.log(`Added ${source} to ${scope}`);
    printCatalogEntry(source, catalog.jawfish[source], tool);
    return 0;
  }

  if (!(await isImportSource(source))) {
    throw new Error(`Unknown agentic: ${source}`);
  }

  const imported = await importPackage(libraryDir, catalog, source, args.name);
  if (imported.imported) {
    await writeCatalog(libraryDir, catalog);
    if (!(await pushLibraryChanges(libraryDir, `add ${imported.name}`))) {
      return 1;
    }
  }

  await installOne(libraryDir, catalog, imported.name, scope, config);
  console.log(`Added ${imported.name} to ${scope}`);
  return 0;
}

async function initCommand(args: ParsedArgs): Promise<number> {
  if (
    args.force ||
    args.global ||
    args.name !== undefined ||
    args.positionals.length > 1
  ) {
    console.error("Usage: jawfish init [content-library]");
    return 1;
  }

  const config = await loadConfig();
  const source = args.positionals[0];
  if (source !== undefined) {
    config.contentLibrary = source;
    await saveConfig(config);
  }

  const libraryDir = await resolveContentLibrary(config);
  await resolveTool(config);
  console.log(`Initialized jawfish at ${configPath()}`);
  console.log(`Content library: ${libraryDir}`);
  return 0;
}

async function installCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const libraryDir = await resolveContentLibrary(config);
  await syncLibrary(libraryDir);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const names = Object.keys(manifest.jawfish);

  for (const name of names) {
    const tool = manifest.jawfish[name].tool;
    assertSupportedConfiguredTool(tool, `manifest entry "${name}"`);
    await materialize(libraryDir, catalog, name, scope, tool);
  }

  console.log(`Installed ${names.length} jawfish to ${scope}`);
  return 0;
}

async function listCommand(args: ParsedArgs): Promise<number> {
  if (
    args.force ||
    args.global ||
    args.name !== undefined ||
    args.positionals.length > 0 ||
    args.yes
  ) {
    console.error("Usage: jawfish list [options]");
    return 1;
  }

  const type = args.type;
  if (type !== undefined && !isAgenticType(type)) {
    console.error(
      `Unsupported type: ${type}. Supported types: ${agenticTypes.join(", ")}`,
    );
    return 1;
  }

  const installed = args.installed;
  if (installed !== undefined && !isInstalledFilter(installed)) {
    console.error(
      `Unsupported installed filter: ${installed}. Supported filters: ${installedFilters.join(", ")}`,
    );
    return 1;
  }

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const libraryDir = await resolveContentLibrary(config);
  await syncLibrary(libraryDir);
  const catalog = await readCatalog(libraryDir);
  const [projectManifest, globalManifest] = await Promise.all([
    readManifest("project"),
    readManifest("global"),
  ]);
  const entries = catalogEntriesForList(
    libraryDir,
    catalog,
    type,
    projectManifest,
    globalManifest,
  ).filter(
    (entry) =>
      installed === undefined ||
      matchesInstalledFilter(entry.installed, installed),
  );

  if (args.raw) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  console.log(formatCatalogTable(entries));
  return 0;
}

async function importSkillsCommand(args: ParsedArgs): Promise<number> {
  const provider = args.positionals[0];
  if (
    provider === undefined ||
    args.positionals.length !== 1 ||
    args.force ||
    args.global ||
    args.name !== undefined
  ) {
    console.error("Usage: jawfish import-skills [options] <provider>");
    return 1;
  }

  assertSupportedConfiguredTool(provider, "provider");

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const libraryDir = await resolveContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const sourceRoot = globalSkillRoot(provider);
  const plan = await planSkillImport(sourceRoot, catalog);

  printImportSkillsPlan(provider, sourceRoot, plan);

  if (plan.imported.length === 0) {
    console.log("No importable skills found");
    return 0;
  }

  if (!args.yes && !(await confirmImportSkills(plan.imported.length))) {
    console.log("Import cancelled");
    return 0;
  }

  await applySkillImport(libraryDir, catalog, provider, plan.imported);
  await writeCatalog(libraryDir, catalog);
  if (!(await pushLibraryChanges(libraryDir, `import skills from ${provider}`))) {
    return 1;
  }

  console.log(`Imported ${plan.imported.length} skills from ${provider}`);
  return 0;
}

async function upgradeCommand(args: ParsedArgs): Promise<number> {
  if (
    args.force ||
    args.global ||
    args.name !== undefined ||
    args.positionals.length > 0
  ) {
    console.error("Usage: jawfish upgrade");
    return 1;
  }

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

async function removeCommand(args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (name === undefined) {
    console.error("Usage: jawfish remove [options] <name>");
    return 1;
  }

  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const libraryDir = await resolveContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const manifestEntry = manifest.jawfish[name];
  const catalogEntry = catalog.jawfish[name];

  if (manifestEntry !== undefined && catalogEntry !== undefined) {
    assertSupportedConfiguredTool(
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

async function updateCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const libraryDir = await resolveContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const name = args.positionals[0];
  const reinstallScope = getScope(args);

  if (name !== undefined) {
    await updatePackage(libraryDir, catalog, name, args.force);
    await writeCatalog(libraryDir, catalog);
    if (!(await pushLibraryChanges(libraryDir, `update ${name}`))) {
      return 1;
    }

    await reinstallInScopeIfPresent(
      libraryDir,
      catalog,
      name,
      reinstallScope,
      config,
    );
    console.log(`Updated ${name}`);
    return 0;
  }

  const summary = await updateAllPackages(libraryDir, catalog, args.force);

  if (summary.failed.length === 0 && summary.updated.length > 0) {
    await writeCatalog(libraryDir, catalog);
    if (!(await pushLibraryChanges(libraryDir, "update jawfish"))) {
      printBulkUpdateSummary(summary);
      return 1;
    }

    await Promise.all(
      summary.updated.map((updatedName) =>
        reinstallInScopeIfPresent(
          libraryDir,
          catalog,
          updatedName,
          reinstallScope,
          config,
        ),
      ),
    );
  }

  printBulkUpdateSummary(summary);
  return summary.failed.length > 0 ? 1 : 0;
}

async function installOne(
  libraryDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  config: JawfishConfig,
): Promise<string> {
  const tool = await resolveTool(config);
  await materialize(libraryDir, catalog, name, scope, tool);

  const manifest = await readManifest(scope);
  manifest.jawfish[name] = { tool };
  await writeManifest(scope, manifest);
  return tool;
}

async function materialize(
  libraryDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  tool: string,
): Promise<void> {
  const entry = catalog.jawfish[name];
  if (entry === undefined) {
    throw new Error(`Unknown agentic: ${name}`);
  }

  const sourcePath = resolveInside(libraryDir, entry.path);
  const destination = destinationSpec(
    name,
    entry.type,
    scope,
    tool,
    toolPaths(),
  );
  const sourceFiles = await packageFiles(sourcePath);

  if (destination.kind === "file") {
    await copyNativeFile(destination, sourceFiles, name, tool, entry.type);
    return;
  }

  const managedFiles = await managedFileSet(destination.path);

  await assertNoUnmanagedConflicts(destination.path, sourceFiles, managedFiles);
  await mkdir(destination.path, { recursive: true });
  await removeStaleManagedFiles(destination.path, sourceFiles, managedFiles);
  await copyPackageFiles(destination.path, sourceFiles);

  await writeJson(join(destination.path, managedMarkerFile), {
    files: sourceFiles.map((file) => file.relativePath).sort(),
    name,
    tool,
    type: entry.type,
  });
}

async function copyNativeFile(
  destination: Extract<DestinationSpec, { kind: "file" }>,
  sourceFiles: PackageFile[],
  name: string,
  tool: string,
  type: AgenticType,
): Promise<void> {
  if (sourceFiles.length !== 1) {
    throw new Error(
      `Native ${destination.extension} destinations require exactly one source file: ${destination.path}`,
    );
  }

  const [sourceFile] = sourceFiles;
  if (extname(sourceFile.path) !== destination.extension) {
    throw new Error(
      `Native destination requires a ${destination.extension} source file: ${sourceFile.path}`,
    );
  }

  await assertNoUnmanagedNativeConflict(destination.path);
  await mkdir(dirname(destination.path), { recursive: true });
  await cp(sourceFile.path, destination.path);
  await writeJson(nativeMarkerPath(destination.path), {
    files: [basename(destination.path)],
    name,
    tool,
    type,
  });
}

async function assertNoUnmanagedNativeConflict(path: string): Promise<void> {
  if ((await exists(path)) && !(await exists(nativeMarkerPath(path)))) {
    throw new Error(
      `Refusing to overwrite unmanaged destination file: ${path}\n` +
        "Remove it or move it aside, then retry.",
    );
  }
}

async function assertNoUnmanagedConflicts(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    if (
      (await exists(installedPath)) &&
      !managedFiles.has(sourceFile.relativePath)
    ) {
      throw new Error(
        `Refusing to overwrite unmanaged destination file: ${installedPath}\n` +
          "Remove it or move it aside, then retry.",
      );
    }
  }
}

async function removeStaleManagedFiles(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  const sourceFileNames = new Set(sourceFiles.map((file) => file.relativePath));
  for (const managedFile of managedFiles) {
    if (!sourceFileNames.has(managedFile)) {
      const installedPath = join(destination, managedFile);
      await rm(installedPath, { force: true });
      await removeEmptyParents(dirname(installedPath), destination);
    }
  }
}

async function copyPackageFiles(
  destination: string,
  sourceFiles: PackageFile[],
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    await mkdir(dirname(installedPath), { recursive: true });
    await cp(sourceFile.path, installedPath);
  }
}

async function removeMaterialized(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
): Promise<void> {
  const destination = destinationSpec(name, type, scope, tool, toolPaths());
  if (destination.kind === "file") {
    await removeManagedNativeFile(destination.path);
    return;
  }

  await removeManagedDestination(destination.path);
}

async function managedFileSet(destination: string): Promise<Set<string>> {
  if (!(await exists(destination))) {
    return new Set();
  }

  const markerPath = join(destination, managedMarkerFile);
  if (!(await exists(markerPath))) {
    throw new Error(
      `Refusing to overwrite unmanaged destination: ${destination}\n` +
        "Remove it or move it aside, then retry.",
    );
  }

  const marker = JSON.parse(
    await readFile(markerPath, "utf8"),
  ) as ManagedMarker;
  if (Array.isArray(marker.files)) {
    return new Set(marker.files);
  }

  return new Set(await installedFiles(destination));
}

async function removeManagedDestination(destination: string): Promise<void> {
  if (!(await exists(destination))) {
    return;
  }

  const markerPath = join(destination, managedMarkerFile);
  if (!(await exists(markerPath))) {
    return;
  }

  for (const managedFile of await managedFileSet(destination)) {
    const installedPath = join(destination, managedFile);
    await rm(installedPath, { force: true });
    await removeEmptyParents(dirname(installedPath), destination);
  }

  await rm(markerPath, { force: true });
  await removeEmptyParents(destination, destination);
}

async function removeManagedNativeFile(path: string): Promise<void> {
  const markerPath = nativeMarkerPath(path);
  if (!(await exists(markerPath))) {
    return;
  }

  await rm(path, { force: true });
  await rm(markerPath, { force: true });
  await removeEmptyParents(dirname(markerPath), dirname(dirname(markerPath)));
}

function nativeMarkerPath(path: string): string {
  return join(dirname(path), ".jawfish-managed", `${basename(path)}.json`);
}

interface PackageFile {
  path: string;
  relativePath: string;
}

async function packageFiles(sourcePath: string): Promise<PackageFile[]> {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    return [{ path: sourcePath, relativePath: basename(sourcePath) }];
  }

  return directoryFiles(sourcePath, sourcePath);
}

async function installedFiles(destination: string): Promise<string[]> {
  return (await directoryFiles(destination, destination))
    .map((file) => file.relativePath)
    .filter((file) => file !== managedMarkerFile);
}

async function directoryFiles(
  root: string,
  current: string,
): Promise<PackageFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: PackageFile[] = [];

  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await directoryFiles(root, path)));
      continue;
    }

    if (entry.isFile()) {
      files.push({
        path,
        relativePath: relative(root, path),
      });
    }
  }

  return files;
}

async function removeEmptyParents(start: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  let current = resolve(start);

  while (current === resolvedRoot || current.startsWith(`${resolvedRoot}/`)) {
    if (!(await exists(current))) {
      current = dirname(current);
      continue;
    }

    if ((await readdir(current)).length > 0) {
      return;
    }

    await rm(current, { force: true, recursive: true });
    if (current === resolvedRoot) {
      return;
    }

    current = dirname(current);
  }
}

async function importPackage(
  libraryDir: string,
  catalog: Catalog,
  source: string,
  nameOverride: string | undefined,
): Promise<ImportPackageResult> {
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
  const destination = resolveInside(libraryDir, packagePath);

  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(acquired.packagePath, destination, { recursive: true });

  catalog.jawfish[name] = {
    description: "",
    path: packagePath,
    type,
    upstream: source,
  };

  return { imported: true, name };
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

async function planSkillImport(
  sourceRoot: string,
  catalog: Catalog,
): Promise<ImportSkillsPlan> {
  const plan: ImportSkillsPlan = { conflicts: [], imported: [], skipped: [] };
  if (!(await exists(sourceRoot))) {
    return plan;
  }

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const sourcePath = join(sourceRoot, entry.name);
    const skillPath = join(sourcePath, "SKILL.md");
    if (!(await exists(skillPath))) {
      plan.skipped.push({
        name: entry.name,
        reason: "missing SKILL.md",
      });
      continue;
    }

    if (catalogHasAgentic(catalog, entry.name)) {
      plan.conflicts.push(entry.name);
      continue;
    }

    plan.imported.push({ name: entry.name, path: sourcePath });
  }

  plan.conflicts.sort();
  plan.imported.sort((left, right) => left.name.localeCompare(right.name));
  plan.skipped.sort((left, right) => left.name.localeCompare(right.name));
  return plan;
}

function printImportSkillsPlan(
  provider: string,
  sourceRoot: string,
  plan: ImportSkillsPlan,
): void {
  console.log(`Import skills from ${provider}`);
  console.log(`source: ${sourceRoot}`);
  console.log(
    `import: ${formatSummaryNames(plan.imported.map((skill) => skill.name))}`,
  );
  console.log(`conflicts: ${formatSummaryNames(plan.conflicts)}`);
  console.log(`skipped: ${formatImportSkillSkips(plan.skipped)}`);
}

function formatImportSkillSkips(skipped: ImportSkillsSkip[]): string {
  if (skipped.length === 0) {
    return "none";
  }

  return skipped.map((skip) => `${skip.name} (${skip.reason})`).join(", ");
}

async function confirmImportSkills(count: number): Promise<boolean> {
  const selected = await confirm({
    message: `Import ${count} skills?`,
    initialValue: true,
  });

  if (isCancel(selected)) {
    cancel("Import cancelled");
    return false;
  }

  return selected;
}

async function applySkillImport(
  libraryDir: string,
  catalog: Catalog,
  provider: string,
  skills: DiscoveredSkill[],
): Promise<void> {
  const manifest = await readManifest("global");

  for (const skill of skills) {
    const packagePath = join(typeFolder("skill"), skill.name);
    const destination = resolveInside(libraryDir, packagePath);

    await rm(destination, { force: true, recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(skill.path, destination, { recursive: true });
    await rm(join(destination, managedMarkerFile), { force: true });

    catalog.jawfish[skill.name] = {
      description: "",
      path: packagePath,
      type: "skill",
    };
    manifest.jawfish[skill.name] = { tool: provider };
    await adoptGlobalSkill(skill, provider);
  }

  await writeManifest("global", manifest);
}

async function adoptGlobalSkill(
  skill: DiscoveredSkill,
  provider: string,
): Promise<void> {
  await writeJson(join(skill.path, managedMarkerFile), {
    files: (await installedFiles(skill.path)).sort(),
    name: skill.name,
    tool: provider,
    type: "skill",
  });
}

async function acquireSource(source: string): Promise<AcquiredSource> {
  return isUrl(source) ? acquireUrlSource(source) : acquireLocalSource(source);
}

async function isImportSource(source: string): Promise<boolean> {
  if (isUrl(source)) {
    return true;
  }

  return exists(resolve(process.cwd(), source));
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

function isAgenticType(value: string): value is AgenticType {
  return agenticTypes.includes(value as AgenticType);
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

async function updatePackage(
  libraryDir: string,
  catalog: Catalog,
  name: string,
  force: boolean,
): Promise<void> {
  const entry = catalog.jawfish[name];
  if (entry === undefined) {
    throw new Error(`Unknown agentic: ${name}`);
  }

  if (entry.upstream === undefined) {
    throw new Error(`Agentic has no upstream: ${name}`);
  }

  const dirty = await dirtyPaths(libraryDir, entry.path);
  if (dirty.length > 0 && !force) {
    throw new Error(
      `Package has dirty local changes: ${name}\n` +
        dirty.map((path) => `  ${path}`).join("\n") +
        "\nRun jawfish update --force " +
        name +
        " to replace them.",
    );
  }

  const acquired = await acquireSource(entry.upstream);
  const destination = resolveInside(libraryDir, entry.path);
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(acquired.packagePath, destination, { recursive: true });
}

async function updateAllPackages(
  libraryDir: string,
  catalog: Catalog,
  force: boolean,
): Promise<BulkUpdateSummary> {
  const summary: BulkUpdateSummary = { failed: [], skipped: [], updated: [] };

  for (const name of Object.keys(catalog.jawfish)) {
    const entry = catalog.jawfish[name];
    if (entry.upstream === undefined) {
      summary.skipped.push(name);
      continue;
    }

    try {
      await updatePackage(libraryDir, catalog, name, force);
      summary.updated.push(name);
    } catch (error) {
      const failure = bulkUpdateFailure(name, error);
      summary.failed.push(failure);
      console.error(`Failed to update ${name}:\n${failure.details}`);
    }
  }

  return summary;
}

function printBulkUpdateSummary(summary: BulkUpdateSummary): void {
  console.log(`Updated: ${formatSummaryNames(summary.updated)}`);
  console.log(`Skipped: ${formatSummaryNames(summary.skipped)}`);
  console.log(`Failed: ${formatBulkUpdateFailures(summary.failed)}`);
}

function formatSummaryNames(names: string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function formatBulkUpdateFailures(failures: BulkUpdateFailure[]): string {
  if (failures.length === 0) {
    return "none";
  }

  return failures
    .map((failure) => `${failure.name} (${failure.message})`)
    .join(", ");
}

function bulkUpdateFailure(name: string, error: unknown): BulkUpdateFailure {
  const details = stringifyError(error);
  return {
    details,
    message: details.split("\n")[0],
    name,
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reinstallInScopeIfPresent(
  libraryDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  _config: JawfishConfig,
): Promise<void> {
  const manifest = await readManifest(scope);
  const entry = manifest.jawfish[name];
  if (entry !== undefined) {
    assertSupportedConfiguredTool(entry.tool, `manifest entry "${name}"`);
    await materialize(libraryDir, catalog, name, scope, entry.tool);
  }
}

async function resolveTool(config: JawfishConfig): Promise<string> {
  if (config.defaultTool !== undefined) {
    assertSupportedConfiguredTool(config.defaultTool, "config defaultTool");
    return config.defaultTool;
  }

  const selected = await promptForTool(defaultSupportedTools);
  if (selected === "") {
    throw new Error("No default tool selected");
  }

  assertSupportedConfiguredTool(selected, "selected default tool");
  config.defaultTool = selected;
  await saveConfig(config);
  return selected;
}

async function resolveContentLibrary(config: JawfishConfig): Promise<string> {
  if (config.contentLibrary === undefined || config.contentLibrary === "") {
    const libraryDir = managedLibraryPath();
    await initializeLocalManagedLibrary(libraryDir);
    config.contentLibrary = libraryDir;
    await saveConfig(config);
    return libraryDir;
  }

  const configured = isAbsolute(config.contentLibrary)
    ? config.contentLibrary
    : resolve(process.cwd(), config.contentLibrary);

  if (resolve(configured) === resolve(deprecatedLibraryPath())) {
    throw new Error(
      `Nested content library is no longer supported: ${configured}\n` +
        `Move the library to ${managedLibraryPath()} and update ${configPath()}.`,
    );
  }

  if ((await exists(configured)) && !(await isBareRepository(configured))) {
    await ensureLibraryIgnore(configured);
    return configured;
  }

  const libraryDir = managedLibraryPath();
  if (await exists(join(libraryDir, ".git"))) {
    await configureManagedLibraryUser(libraryDir);
    await ensureLibraryIgnore(libraryDir);
    return libraryDir;
  }

  await initializeManagedLibrary(config.contentLibrary, libraryDir);
  await ensureLibraryIgnore(libraryDir);
  return libraryDir;
}

async function initializeLocalManagedLibrary(libraryDir: string): Promise<void> {
  await mkdir(libraryDir, { recursive: true });
  if (!(await exists(join(libraryDir, ".git")))) {
    await runCommand("git", ["init"], libraryDir);
  }

  await configureManagedLibraryUser(libraryDir);
  await ensureLibraryIgnore(libraryDir);
}

async function initializeManagedLibrary(
  source: string,
  libraryDir: string,
): Promise<void> {
  await mkdir(libraryDir, { recursive: true });
  await runCommand("git", ["init"], libraryDir);
  await configureManagedLibraryUser(libraryDir);
  await runCommand("git", ["remote", "add", "origin", source], libraryDir);
  await runCommand("git", ["fetch", "origin"], libraryDir);

  const branch = await remoteDefaultBranch(libraryDir);
  await runCommand(
    "git",
    ["checkout", "-B", branch, `origin/${branch}`],
    libraryDir,
  );
  await runCommand(
    "git",
    ["branch", "--set-upstream-to", `origin/${branch}`, branch],
    libraryDir,
  );
}

async function configureManagedLibraryUser(libraryDir: string): Promise<void> {
  const email = await runCommand(
    "git",
    ["config", "--get", "user.email"],
    libraryDir,
    false,
  );
  if (email.exitCode !== 0 || email.stdout.trim() === "") {
    await runCommand(
      "git",
      ["config", "user.email", "jawfish@example.invalid"],
      libraryDir,
    );
  }

  const name = await runCommand(
    "git",
    ["config", "--get", "user.name"],
    libraryDir,
    false,
  );
  if (name.exitCode !== 0 || name.stdout.trim() === "") {
    await runCommand("git", ["config", "user.name", "Jawfish"], libraryDir);
  }
}

async function remoteDefaultBranch(libraryDir: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["ls-remote", "--symref", "origin", "HEAD"],
    libraryDir,
  );
  const match = /^ref: refs\/heads\/([^\t]+)\tHEAD$/mu.exec(result.stdout);
  if (match === null) {
    throw new Error("Could not determine content library default branch");
  }

  return match[1];
}

async function readCatalog(libraryDir: string): Promise<Catalog> {
  const indexPath = join(libraryDir, indexCatalogFile);
  if (await exists(indexPath)) {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `Invalid catalog at ${indexPath}: expected name-keyed object`,
      );
    }

    return validateCatalog(indexPath, {
      jawfish: parsed as Record<string, CatalogEntry>,
    });
  }

  const legacyPath = join(libraryDir, catalogFile);
  if (await exists(legacyPath)) {
    const parsed = JSON.parse(
      await readFile(legacyPath, "utf8"),
    ) as Partial<Catalog>;
    return validateCatalog(legacyPath, { jawfish: parsed.jawfish ?? {} });
  }

  return { jawfish: {} };
}

async function writeCatalog(
  libraryDir: string,
  catalog: Catalog,
): Promise<void> {
  await writeJson(join(libraryDir, indexCatalogFile), catalog.jawfish);
  await rm(join(libraryDir, catalogFile), { force: true });
}

function validateCatalog(path: string, catalog: Catalog): Catalog {
  const issues: string[] = [];

  for (const [name, entry] of Object.entries(catalog.jawfish)) {
    issues.push(...catalogEntryIssues(name, entry));
  }

  if (issues.length > 0) {
    throw new Error(`Invalid catalog at ${path}: ${issues.join("; ")}`);
  }

  return catalog;
}

function catalogEntryIssues(name: string, entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${name}: expected object`];
  }

  const issues: string[] = [];

  if (!("description" in entry) || typeof entry.description !== "string") {
    issues.push(`${name}.description`);
  }

  if (!("path" in entry) || typeof entry.path !== "string") {
    issues.push(`${name}.path`);
  }

  if (
    !("type" in entry) ||
    (entry.type !== "skill" &&
      entry.type !== "agent" &&
      entry.type !== "prompt")
  ) {
    issues.push(`${name}.type`);
  }

  if ("upstream" in entry && typeof entry.upstream !== "string") {
    issues.push(`${name}.upstream`);
  }

  return issues;
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

interface ListCatalogEntry {
  description: string;
  installed: InstalledStatus;
  name: string;
  path: string;
  type: AgenticType;
}

type InstalledStatus = "project" | "global" | "both" | "-";
const installedFilters = ["project", "global", "both", "none", "any"] as const;
type InstalledFilter = (typeof installedFilters)[number];

function catalogEntriesForList(
  libraryDir: string,
  catalog: Catalog,
  type: AgenticType | undefined,
  projectManifest: Manifest,
  globalManifest: Manifest,
): ListCatalogEntry[] {
  return Object.entries(catalog.jawfish)
    .filter(([, entry]) => type === undefined || entry.type === type)
    .map(([name, entry]) => ({
      description: entry.description,
      installed: installedStatus(name, projectManifest, globalManifest),
      name,
      path: compactHomePath(resolveInside(libraryDir, entry.path)),
      type: entry.type,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function installedStatus(
  name: string,
  projectManifest: Manifest,
  globalManifest: Manifest,
): InstalledStatus {
  const project = projectManifest.jawfish[name] !== undefined;
  const global = globalManifest.jawfish[name] !== undefined;

  if (project && global) {
    return "both";
  }

  if (project) {
    return "project";
  }

  if (global) {
    return "global";
  }

  return "-";
}

function isInstalledFilter(value: string): value is InstalledFilter {
  return installedFilters.includes(value as InstalledFilter);
}

function matchesInstalledFilter(
  status: InstalledStatus,
  filter: InstalledFilter,
): boolean {
  switch (filter) {
    case "project":
      return status === "project" || status === "both";
    case "global":
      return status === "global" || status === "both";
    case "both":
      return status === "both";
    case "none":
      return status === "-";
    case "any":
      return status !== "-";
  }
}

function compactHomePath(path: string): string {
  const home = resolve(homedir());
  const resolved = resolve(path);
  const pathRelativeToHome = relative(home, resolved);

  if (pathRelativeToHome === "") {
    return "~";
  }

  if (
    !pathRelativeToHome.startsWith("..") &&
    !isAbsolute(pathRelativeToHome)
  ) {
    return join("~", pathRelativeToHome);
  }

  return resolved;
}

function formatCatalogTable(entries: ListCatalogEntry[]): string {
  const columns = ["name", "type", "installed", "description"] as const;
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...entries.map((entry) => String(entry[column]).length),
    ),
  );
  const top = tableBorder("┌", "┬", "┐", widths);
  const middle = tableBorder("├", "┼", "┤", widths);
  const bottom = tableBorder("└", "┴", "┘", widths);
  const header = tableRow([...columns], widths);
  const rows = entries.map((entry) =>
    tableRow(
      [entry.name, entry.type, entry.installed, entry.description],
      widths,
    ),
  );

  return [top, header, middle, ...rows, bottom].join("\n");
}

function tableBorder(
  left: string,
  joiner: string,
  right: string,
  widths: number[],
): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(joiner)}${right}`;
}

function tableRow(values: string[], widths: number[]): string {
  return `│ ${values
    .map((value, index) => value.padEnd(widths[index]))
    .join(" │ ")} │`;
}

async function readManifest(scope: InstallScope): Promise<Manifest> {
  const path = manifestPath(scope);
  if (!(await exists(path))) {
    return { jawfish: {} };
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Manifest>;
  return { jawfish: parsed.jawfish ?? {} };
}

async function writeManifest(
  scope: InstallScope,
  manifest: Manifest,
): Promise<void> {
  await writeJson(manifestPath(scope), manifest);
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

function globalSkillRoot(tool: string): string {
  return dirname(
    destinationSpec(
      "__jawfish_import_probe__",
      "skill",
      "global",
      tool,
      toolPaths(),
    ).path,
  );
}

function getScope(args: ParsedArgs): InstallScope {
  return args.global ? "global" : "project";
}

async function isBareRepository(path: string): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["rev-parse", "--is-bare-repository"],
    path,
    false,
  );

  return result.exitCode === 0 && result.stdout.trim() === "true";
}

function parseArgs(args: string[], command: CommandName): ParsedArgs {
  const parsed: ParsedArgs = {
    force: false,
    global: false,
    help: false,
    positionals: [],
    raw: false,
    yes: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "-F":
      case "--force":
        parsed.force = true;
        break;
      case "-g":
      case "--global":
        parsed.global = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-y":
      case "--yes":
        parsed.yes = true;
        break;
      case "--raw":
        if (command !== "list") {
          parsed.positionals.push(arg);
          break;
        }

        parsed.raw = true;
        break;
      case "--name": {
        const name = args[index + 1];
        if (name === undefined) {
          throw new Error("--name requires a value");
        }

        parsed.name = name;
        index += 1;
        break;
      }
      case "--type": {
        if (command !== "list") {
          parsed.positionals.push(arg);
          break;
        }

        const type = args[index + 1];
        if (type === undefined) {
          throw new Error("--type requires a value");
        }

        parsed.type = type;
        index += 1;
        break;
      }
      case "--installed": {
        if (command !== "list") {
          parsed.positionals.push(arg);
          break;
        }

        const installed = args[index + 1];
        if (installed === undefined) {
          throw new Error("--installed requires a value");
        }

        parsed.installed = installed;
        index += 1;
        break;
      }
      default:
        parsed.positionals.push(arg);
        break;
    }
  }

  return parsed;
}

function printRootHelp(): void {
  const commandWidth =
    Math.max(...commandNames.map((command) => command.length)) + 2;

  console.log(`jawfish ${version}

Usage: jawfish <command> [options]

Commands:
${commandNames
  .map(
    (command) =>
      `  ${command.padEnd(commandWidth)}${commandSpecs[command].summary}`,
  )
  .join("\n")}

Options:
  -h, --help      Show help
  -v, --version   Show version`);
}

function printCommandHelp(command: CommandName): void {
  const spec = commandSpecs[command];

  console.log(`${spec.description}

Usage: ${spec.usage}

Options:
${spec.options.map((option) => `  ${option}`).join("\n")}`);
}

async function syncLibrary(libraryDir: string): Promise<void> {
  if (!(await exists(join(libraryDir, ".git")))) {
    return;
  }

  const upstream = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    libraryDir,
    false,
  );
  if (upstream.exitCode !== 0) {
    return;
  }

  await runCommand("git", ["pull", "--ff-only"], libraryDir);
}

async function dirtyPaths(
  libraryDir: string,
  packagePath: string,
): Promise<string[]> {
  if (!(await exists(join(libraryDir, ".git")))) {
    return [];
  }

  const result = await runCommand(
    "git",
    ["status", "--porcelain", "--", packagePath],
    libraryDir,
  );

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function commitAndPush(
  libraryDir: string,
  message: string,
): Promise<PushResult> {
  if (!(await exists(join(libraryDir, ".git")))) {
    return { ok: true };
  }

  await ensureLibraryIgnore(libraryDir);
  await runCommand("git", ["add", "."], libraryDir);
  const status = await runCommand("git", ["status", "--porcelain"], libraryDir);
  if (status.stdout.trim() === "") {
    return { ok: true };
  }

  await runCommand("git", ["commit", "-m", message], libraryDir);
  if (!(await hasPushDestination(libraryDir))) {
    return { ok: true };
  }

  const push = await runCommand("git", ["push"], libraryDir, false);
  if (push.exitCode !== 0) {
    return { ok: false, error: push.stderr || push.stdout };
  }

  return { ok: true };
}

async function hasPushDestination(libraryDir: string): Promise<boolean> {
  const result = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    libraryDir,
    false,
  );

  return result.exitCode === 0 && result.stdout.trim() !== "";
}

async function pushLibraryChanges(
  libraryDir: string,
  message: string,
): Promise<boolean> {
  const pushResult = await commitAndPush(libraryDir, message);
  if (pushResult.ok) {
    return true;
  }

  printPushFailure(pushResult.error, libraryDir);
  return false;
}

function printPushFailure(error: string, libraryDir: string): void {
  console.error("Library commit was created, but push failed.");
  console.error(error.trim());
  console.error(`Recover with: git -C ${libraryDir} push`);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  throwOnFailure = true,
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    waitForExit(child),
  ]);
  const result = { exitCode, stderr, stdout };

  if (throwOnFailure && exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${exitCode ?? "unknown"})\n${stderr}`,
    );
  }

  return result;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensureLibraryIgnore(libraryDir: string): Promise<void> {
  const ignorePath = join(libraryDir, ".gitignore");
  const existing = (await exists(ignorePath))
    ? await readFile(ignorePath, "utf8")
    : "";
  const existingEntries = new Set(
    existing.split("\n").map((line) => line.trim()),
  );
  const missing = libraryIgnoreEntries.filter(
    (entry) => !existingEntries.has(entry),
  );
  if (missing.length === 0) {
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(ignorePath, `${existing}${separator}${missing.join("\n")}\n`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const parentRelative = relative(root, resolved);
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new Error(`Path escapes content library: ${path}`);
  }

  return resolved;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//u.test(value);
}

const promptExtensions = new Set([".md", ".txt", ".prompt"]);

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commandSpecs, value);
}

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

async function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  });
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";

  for await (const chunk of stream) {
    output += String(chunk);
  }

  return output;
}

if (await isMainModule()) {
  process.exitCode = await run(process.argv.slice(2));
}
