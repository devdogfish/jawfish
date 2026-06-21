#!/usr/bin/env -S node --experimental-strip-types
import { cancel, isCancel, select } from "@clack/prompts";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
  assertSupportedTool,
  destinationPath,
  supportedTools,
  typeFolder,
  type AgenticType,
  type InstallScope,
  type ToolPaths,
} from "./tool-adapters.ts";

const version = "0.1.0";
const catalogFile = "catalog.json";
const indexCatalogFile = "index.json";
const projectManifestFile = "agentics.json";
const managedMarkerFile = ".agentics-managed.json";
const defaultTools = supportedTools;
const agenticTypes = ["skill", "agent", "prompt"] as const satisfies readonly AgenticType[];

interface CommandSpec {
  description: string;
  summary: string;
  usage: string;
  options: string[];
}

interface Config {
  allowedTools: string[];
  contentLibrary?: string;
  defaultTool?: string;
}

interface Catalog {
  agentics: Record<string, CatalogEntry>;
}

interface CatalogEntry {
  description: string;
  path: string;
  type: AgenticType;
  upstream?: string;
}

interface Manifest {
  agentics: Record<string, ManifestEntry>;
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
  name?: string;
  positionals: string[];
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

interface BulkUpdateSummary {
  failed: string[];
  skipped: string[];
  updated: string[];
}

const commandSpecs = {
  add: {
    description: "Install an agentic from the library, or import a URL/local path.",
    summary: "Install or import an agentic",
    usage: "agentics add [options] <name|source>",
    options: [
      "-g, --global    Install globally",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
  },
  install: {
    description: "Materialize manifest agentics into tool-native directories.",
    summary: "Materialize manifest agentics",
    usage: "agentics install [options]",
    options: ["-g, --global    Install global manifest", "-h, --help      Show help"],
  },
  update: {
    description: "Refresh one or all upstream-backed agentics.",
    summary: "Update upstream-backed agentics",
    usage: "agentics update [options] [name]",
    options: [
      "-g, --global    Reinstall global manifest if already installed",
      "-F, --force     Replace dirty package contents",
      "-h, --help      Show help",
    ],
  },
  remove: {
    description: "Remove installed managed agentics.",
    summary: "Remove installed agentics",
    usage: "agentics remove [options] <name>",
    options: ["-g, --global    Remove global install", "-h, --help      Show help"],
  },
} as const satisfies Record<string, CommandSpec>;

type CommandName = keyof typeof commandSpecs;
const commandNames = Object.keys(commandSpecs) as CommandName[];

export async function promptForTool(allowedTools: string[]): Promise<string> {
  const selected = await select({
    message: "Select default tool",
    options: allowedTools.map((tool) => ({ label: tool, value: tool })),
  });

  if (isCancel(selected)) {
    cancel("No tool selected");
    process.exitCode = 1;
    return "";
  }

  return selected;
}

export async function promptForAgenticType(packagePath: string): Promise<AgenticType> {
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
      console.error("Run agentics --help for usage.");
      return 1;
    }

    const parsed = parseArgs(args);
    if (parsed.help) {
      printCommandHelp(command);
      return 0;
    }

    switch (command) {
      case "add":
        return await addCommand(parsed);
      case "install":
        return await installCommand(parsed);
      case "remove":
        return await removeCommand(parsed);
      case "update":
        return await updateCommand(parsed);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function addCommand(args: ParsedArgs): Promise<number> {
  const source = args.positionals[0];
  if (source === undefined) {
    console.error("Usage: agentics add [options] <name|source>");
    return 1;
  }

  const config = await loadConfig();
  const libraryDir = await resolveContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);

  if (catalogHasAgentic(catalog, source)) {
    const tool = await installOne(libraryDir, catalog, source, scope, config);
    console.log(`Added ${source} to ${scope}`);
    printCatalogEntry(source, catalog.agentics[source], tool);
    return 0;
  }

  const imported = await importPackage(libraryDir, catalog, source, args.name);
  await writeCatalog(libraryDir, catalog);
  if (!(await pushLibraryChanges(libraryDir, `add ${imported}`))) {
    return 1;
  }

  await installOne(libraryDir, catalog, imported, scope, config);
  console.log(`Added ${imported} to ${scope}`);
  return 0;
}

async function installCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig();
  const libraryDir = await resolveContentLibrary(config);
  await syncLibrary(libraryDir);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const names = Object.keys(manifest.agentics);

  for (const name of names) {
    const tool = manifest.agentics[name].tool;
    assertConfiguredTool(config, tool);
    await materialize(libraryDir, catalog, name, scope, tool);
  }

  console.log(`Installed ${names.length} agentics to ${scope}`);
  return 0;
}

async function removeCommand(args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (name === undefined) {
    console.error("Usage: agentics remove [options] <name>");
    return 1;
  }

  const config = await loadConfig();
  const libraryDir = await resolveContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const manifestEntry = manifest.agentics[name];
  const catalogEntry = catalog.agentics[name];

  if (manifestEntry !== undefined && catalogEntry !== undefined) {
    assertConfiguredTool(config, manifestEntry.tool);
    await removeMaterialized(name, catalogEntry.type, scope, manifestEntry.tool);
  }

  delete manifest.agentics[name];
  await writeManifest(scope, manifest);
  console.log(`Removed ${name} from ${scope}`);
  return 0;
}

async function updateCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig();
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

    await reinstallInScopeIfPresent(libraryDir, catalog, name, reinstallScope, config);
    console.log(`Updated ${name}`);
    return 0;
  }

  const summary = await updateAllPackages(libraryDir, catalog, args.force);

  if (summary.failed.length === 0 && summary.updated.length > 0) {
    await writeCatalog(libraryDir, catalog);
    if (!(await pushLibraryChanges(libraryDir, "update agentics"))) {
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
  config: Config,
): Promise<string> {
  const tool = await resolveTool(config);
  await materialize(libraryDir, catalog, name, scope, tool);

  const manifest = await readManifest(scope);
  manifest.agentics[name] = { tool };
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
  const entry = catalog.agentics[name];
  if (entry === undefined) {
    throw new Error(`Unknown agentic: ${name}`);
  }

  const sourcePath = resolveInside(libraryDir, entry.path);
  const destination = destinationPath(name, entry.type, scope, tool, toolPaths());
  const managedFiles = await managedFileSet(destination);
  const sourceFiles = await packageFiles(sourcePath);

  await assertNoUnmanagedConflicts(destination, sourceFiles, managedFiles);
  await mkdir(destination, { recursive: true });
  await removeStaleManagedFiles(destination, sourceFiles, managedFiles);
  await copyPackageFiles(destination, sourceFiles);

  await writeJson(join(destination, managedMarkerFile), {
    files: sourceFiles.map((file) => file.relativePath).sort(),
    name,
    tool,
    type: entry.type,
  });
}

async function assertNoUnmanagedConflicts(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    if ((await exists(installedPath)) && !managedFiles.has(sourceFile.relativePath)) {
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
  const destination = destinationPath(name, type, scope, tool, toolPaths());
  await removeManagedDestination(destination);
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

  const marker = JSON.parse(await readFile(markerPath, "utf8")) as ManagedMarker;
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

async function directoryFiles(root: string, current: string): Promise<PackageFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: PackageFile[] = [];

  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await directoryFiles(root, path));
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
): Promise<string> {
  const acquired = await acquireSource(source);
  const name = nameOverride ?? acquired.inferredName;

  if (catalogHasAgentic(catalog, name)) {
    throw new Error(`Agentic already exists in catalog: ${name}`);
  }

  const type = await inferType(acquired.packagePath, acquired.entryFile);
  const packagePath = join(typeFolder(type), name);
  const destination = resolveInside(libraryDir, packagePath);

  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(acquired.packagePath, destination, { recursive: true });

  catalog.agentics[name] = {
    description: "",
    path: packagePath,
    type,
    upstream: source,
  };

  return name;
}

async function acquireSource(source: string): Promise<AcquiredSource> {
  return isUrl(source) ? acquireUrlSource(source) : acquireLocalSource(source);
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
  const tempDir = await mkdtemp(join(tmpdir(), "agentics-source-"));
  const url = new URL(source);
  const fileName = basename(url.pathname) || "agentic.md";
  const sourceResponse = await fetchUrl(source);

  if (isDirectoryListing(sourceResponse)) {
    await downloadUrlDirectory(source, tempDir, sourceResponse.links);
    return {
      inferredName: inferUrlPackageName(url.pathname),
      packagePath: tempDir,
    };
  }

  const parentUrl = new URL(".", source).toString();
  const parentResponse = await fetchUrl(parentUrl, false);
  const filePath = join(tempDir, fileName);

  if (parentResponse !== undefined && isDirectoryListing(parentResponse)) {
    await downloadUrlDirectory(parentUrl, tempDir, parentResponse.links);
  } else {
    await writeFile(filePath, sourceResponse.body);
  }

  return {
    entryFile: filePath,
    inferredName: inferUrlPackageName(dirname(url.pathname)) || inferPackageName(fileName),
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
    if (!throwOnMissing && response.status === 404) {
      return undefined;
    }

    throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  return {
    body,
    contentType,
    links: parseHtmlLinks(body.toString("utf8")),
  };
}

function isDirectoryListing(response: UrlResponse): boolean {
  return response.contentType.includes("text/html") && response.links.length > 0;
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
      await downloadUrlDirectory(childUrl.toString(), childDestination, childResponse.links);
      continue;
    }

    await writeFile(childDestination, childResponse.body);
  }
}

function parseHtmlLinks(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((href) => href !== "" && !href.startsWith("#") && !href.startsWith("?"));
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
  const entry = catalog.agentics[name];
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
        "\nRun agentics update --force " +
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

  for (const name of Object.keys(catalog.agentics)) {
    const entry = catalog.agentics[name];
    if (entry.upstream === undefined) {
      summary.skipped.push(name);
      continue;
    }

    try {
      await updatePackage(libraryDir, catalog, name, force);
      summary.updated.push(name);
    } catch (error) {
      summary.failed.push(`${name} (${errorMessage(error)})`);
      console.error(`Failed to update ${name}:\n${fullErrorMessage(error)}`);
    }
  }

  return summary;
}

function printBulkUpdateSummary(summary: BulkUpdateSummary): void {
  console.log(`Updated: ${formatSummaryNames(summary.updated)}`);
  console.log(`Skipped: ${formatSummaryNames(summary.skipped)}`);
  console.log(`Failed: ${formatSummaryNames(summary.failed)}`);
}

function formatSummaryNames(names: string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function fullErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reinstallInScopeIfPresent(
  libraryDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  config: Config,
): Promise<void> {
  const manifest = await readManifest(scope);
  const entry = manifest.agentics[name];
  if (entry !== undefined) {
    assertConfiguredTool(config, entry.tool);
    await materialize(libraryDir, catalog, name, scope, entry.tool);
  }
}

async function resolveTool(config: Config): Promise<string> {
  const allowedTools = config.allowedTools.length > 0 ? config.allowedTools : [...defaultTools];
  config.allowedTools = allowedTools;

  if (config.defaultTool !== undefined) {
    assertConfiguredTool(config, config.defaultTool);
    return config.defaultTool;
  }

  const selected = await promptForTool(allowedTools);
  if (selected === "") {
    throw new Error("No default tool selected");
  }

  assertConfiguredTool(config, selected);
  config.defaultTool = selected;
  await writeConfig(config);
  return selected;
}

function assertConfiguredTool(config: Config, tool: string): void {
  if (!config.allowedTools.includes(tool)) {
    throw new Error(
      `Tool is not configured: ${tool}. Configured tools: ${config.allowedTools.join(", ")}`,
    );
  }

  assertSupportedTool(tool);
}

async function loadConfig(): Promise<Config> {
  const path = await existingConfigPath();
  const parsed = path === undefined
    ? {}
    : (JSON.parse(await readFile(path, "utf8")) as Partial<Config>);
  const config: Config = {
    allowedTools: parsed.allowedTools ?? [...defaultTools],
    contentLibrary: parsed.contentLibrary ?? process.env.AGENTICS_CONTENT_LIBRARY,
    defaultTool: parsed.defaultTool,
  };
  let changed =
    path === undefined ||
    parsed.allowedTools === undefined ||
    (parsed.contentLibrary === undefined &&
      process.env.AGENTICS_CONTENT_LIBRARY !== undefined);

  const envDefaultTool = process.env.AGENTICS_DEFAULT_TOOL;
  if (config.defaultTool === undefined && envDefaultTool !== undefined) {
    assertConfiguredTool(config, envDefaultTool);
    config.defaultTool = envDefaultTool;
    changed = true;
  }

  if (changed) {
    await writeConfig(config);
  }

  return config;
}

async function writeConfig(config: Config): Promise<void> {
  await writeJson(configPath(), config);
}

async function resolveContentLibrary(config: Config): Promise<string> {
  if (config.contentLibrary === undefined || config.contentLibrary === "") {
    throw new Error(
      `Missing contentLibrary in ${configPath()}\n` +
        "Set it to your agentics content library path or clone URL.",
    );
  }

  const configured = isAbsolute(config.contentLibrary)
    ? config.contentLibrary
    : resolve(process.cwd(), config.contentLibrary);

  if ((await exists(configured)) && !(await isBareRepository(configured))) {
    return configured;
  }

  const libraryDir = managedLibraryPath();
  if (await exists(join(libraryDir, ".git"))) {
    return libraryDir;
  }

  if (await exists(libraryDir)) {
    throw new Error(`Managed content library exists but is not a git clone: ${libraryDir}`);
  }

  await mkdir(agenticsHome(), { recursive: true });
  await runCommand("git", ["clone", config.contentLibrary, libraryDir], agenticsHome());
  return libraryDir;
}

async function readCatalog(libraryDir: string): Promise<Catalog> {
  const indexPath = join(libraryDir, indexCatalogFile);
  if (await exists(indexPath)) {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid catalog at ${indexPath}: expected name-keyed object`);
    }

    return validateCatalog(indexPath, {
      agentics: parsed as Record<string, CatalogEntry>,
    });
  }

  const legacyPath = join(libraryDir, catalogFile);
  if (await exists(legacyPath)) {
    const parsed = JSON.parse(await readFile(legacyPath, "utf8")) as Partial<Catalog>;
    return validateCatalog(legacyPath, { agentics: parsed.agentics ?? {} });
  }

  return { agentics: {} };
}

async function writeCatalog(libraryDir: string, catalog: Catalog): Promise<void> {
  await writeJson(join(libraryDir, indexCatalogFile), catalog.agentics);
  await rm(join(libraryDir, catalogFile), { force: true });
}

function validateCatalog(path: string, catalog: Catalog): Catalog {
  const issues: string[] = [];

  for (const [name, entry] of Object.entries(catalog.agentics)) {
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
    (entry.type !== "skill" && entry.type !== "agent" && entry.type !== "prompt")
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

async function readManifest(scope: InstallScope): Promise<Manifest> {
  const path = manifestPath(scope);
  if (!(await exists(path))) {
    return { agentics: {} };
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Manifest>;
  return { agentics: parsed.agentics ?? {} };
}

async function writeManifest(scope: InstallScope, manifest: Manifest): Promise<void> {
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

  if (detectedTypes.length === 0 && await hasPromptSignal(packagePath, entryFile)) {
    detectedTypes.push("prompt");
  }

  if (detectedTypes.length === 1) {
    return detectedTypes[0];
  }

  const envImportType = process.env.AGENTICS_IMPORT_TYPE;
  if (envImportType !== undefined) {
    if (isAgenticType(envImportType)) {
      return envImportType;
    }

    throw new Error(`Invalid AGENTICS_IMPORT_TYPE: ${envImportType}`);
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

function configPath(): string {
  return join(agenticsHome(), "config.json");
}

function legacyConfigPath(): string {
  return join(xdgConfigHome(), "agentics", "config.json");
}

async function existingConfigPath(): Promise<string | undefined> {
  if (await exists(configPath())) {
    return configPath();
  }

  if (await exists(legacyConfigPath())) {
    return legacyConfigPath();
  }

  return undefined;
}

function managedLibraryPath(): string {
  return join(agenticsHome(), "content-library");
}

function manifestPath(scope: InstallScope): string {
  if (scope === "project") {
    return join(process.cwd(), projectManifestFile);
  }

  return join(agenticsHome(), projectManifestFile);
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homeDir(), ".codex");
}

function toolPaths(): ToolPaths {
  return {
    codexHome: codexHome(),
    homeDir: homeDir(),
    projectDir: process.cwd(),
  };
}

function getScope(args: ParsedArgs): InstallScope {
  return args.global ? "global" : "project";
}

function homeDir(): string {
  return process.env.HOME ?? homedir();
}

function agenticsHome(): string {
  return process.env.AGENTICS_HOME ?? join(homeDir(), ".agentics");
}

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homeDir(), ".config");
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

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    force: false,
    global: false,
    help: false,
    positionals: [],
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
      case "--name": {
        const name = args[index + 1];
        if (name === undefined) {
          throw new Error("--name requires a value");
        }

        parsed.name = name;
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
  console.log(`agentics ${version}

Usage: agentics <command> [options]

Commands:
${commandNames
  .map((command) => `  ${command.padEnd(10)}${commandSpecs[command].summary}`)
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

async function dirtyPaths(libraryDir: string, packagePath: string): Promise<string[]> {
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

  await runCommand("git", ["add", "."], libraryDir);
  const status = await runCommand("git", ["status", "--porcelain"], libraryDir);
  if (status.stdout.trim() === "") {
    return { ok: true };
  }

  await runCommand("git", ["commit", "-m", message], libraryDir);
  const push = await runCommand("git", ["push"], libraryDir, false);
  if (push.exitCode !== 0) {
    return { ok: false, error: push.stderr || push.stdout };
  }

  return { ok: true };
}

async function pushLibraryChanges(libraryDir: string, message: string): Promise<boolean> {
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
  return Object.hasOwn(catalog.agentics, name);
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
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

if (isMainModule()) {
  process.exitCode = await run(process.argv.slice(2));
}
