#!/usr/bin/env -S node --experimental-strip-types
import { cancel, confirm, isCancel, select } from "@clack/prompts";
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
  deprecatedAgenticsRepoPath,
  loadConfig,
  managedAgenticsRepoPath,
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
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from "./install.ts";
import { runCommand } from "./process.ts";
import {
  configureAgenticsRepoGitUser,
  ensureAgenticsRepoIgnore,
  pushAgenticsRepoChanges,
} from "./agentics-repo.ts";
import {
  agenticTypes,
  isAgenticType,
  readCatalog,
  writeCatalog,
  type Catalog,
  type CatalogEntry,
} from "./catalog.ts";
import {
  typeFolder,
  type AgenticType,
  type InstallScope,
} from "./tool-adapters.ts";
import {
  applySkillImport,
  globalSkillRoot,
  planSkillImport,
  printImportSkillsPlan,
} from "./provider-skill-import.ts";

const version = "0.1.2";

interface CommandSpec {
  description: string;
  summary: string;
  usage: string;
  options: string[];
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

interface AcquiredSource {
  entryFile?: string;
  inferredName: string;
  packagePath: string;
}

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

interface ImportPackageResult {
  imported: boolean;
  name: string;
}

interface PackageUpdate {
  catalogEntry: CatalogEntry;
  sourcePath: string;
}

const commandSpecs = {
  add: {
    description:
      "Install an agentic from the agentics repo, or import a URL/local path.",
    summary: "Install or import an agentic",
    usage: "jawfish add [options] <name|source>",
    options: [
      "-g, --global    Install globally",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
  },
  init: {
    description: "Create or edit jawfish machine/project setup.",
    summary: "Create or edit setup",
    usage: "jawfish init [options]",
    options: [
      "-y, --yes       Use noninteractive defaults",
      "-h, --help      Show help",
    ],
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
    description: "List available jawfish in the agentics repo.",
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
const commandOptions: Record<CommandName, readonly string[]> = {
  add: ["-g", "--global", "--name", "-h", "--help"],
  init: ["-y", "--yes", "-h", "--help"],
  install: ["-g", "--global", "--name", "-h", "--help"],
  i: ["-g", "--global", "--name", "-h", "--help"],
  "import-skills": ["-y", "--yes", "-h", "--help"],
  list: ["--type", "--installed", "--raw", "-h", "--help"],
  update: ["-g", "--global", "-F", "--force", "-h", "--help"],
  upgrade: ["-h", "--help"],
  remove: ["-g", "--global", "-h", "--help"],
};

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
  const agenticsRepoDir = await resolveAgenticsRepo(config);
  const catalog = await readCatalog(agenticsRepoDir);
  const scope = getScope(args);

  if (catalogHasAgentic(catalog, source)) {
    const tool = await installOne(agenticsRepoDir, catalog, source, scope, config);
    console.log(`Added ${source} to ${scope}`);
    printCatalogEntry(source, catalog.jawfish[source], tool);
    return 0;
  }

  if (!(await isImportSource(source))) {
    throw new Error(`Unknown agentic: ${source}`);
  }

  const imported = await importPackage(agenticsRepoDir, catalog, source, args.name);
  if (imported.imported) {
    await writeCatalog(agenticsRepoDir, catalog);
    if (!(await pushAgenticsRepoChanges(agenticsRepoDir, `add ${imported.name}`))) {
      return 1;
    }
  }

  await installOne(agenticsRepoDir, catalog, imported.name, scope, config);
  console.log(`Added ${imported.name} to ${scope}`);
  return 0;
}

async function installCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  const agenticsRepoDir = await resolveAgenticsRepo(config);
  await syncAgenticsRepo(agenticsRepoDir);
  const catalog = await readCatalog(agenticsRepoDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const installPlan = Object.entries(manifest.jawfish).map(([name, entry]) => {
    const tool = entry.tool;
    assertSupportedConfiguredTool(tool, `manifest entry "${name}"`);
    if (!catalogHasAgentic(catalog, name)) {
      throw new Error(`Unknown agentic: ${name}`);
    }

    return { name, tool };
  });

  for (const { name, tool } of installPlan) {
    await materialize(agenticsRepoDir, catalog, name, scope, tool);
  }

  console.log(`Installed ${installPlan.length} jawfish to ${scope}`);
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
  const agenticsRepoDir = await resolveAgenticsRepo(config);
  await syncAgenticsRepo(agenticsRepoDir);
  const catalog = await readCatalog(agenticsRepoDir);
  const [projectManifest, globalManifest] = await Promise.all([
    readManifest("project"),
    readManifest("global"),
  ]);
  const entries = catalogEntriesForList(
    agenticsRepoDir,
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
  const agenticsRepoDir = await resolveAgenticsRepo(config);
  const catalog = await readCatalog(agenticsRepoDir);
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

  await applySkillImport(agenticsRepoDir, catalog, provider, plan.imported);
  await writeCatalog(agenticsRepoDir, catalog);
  if (!(await pushAgenticsRepoChanges(agenticsRepoDir, `import skills from ${provider}`))) {
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
  const agenticsRepoDir = await resolveAgenticsRepo(config);
  const catalog = await readCatalog(agenticsRepoDir);
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
  const agenticsRepoDir = await resolveAgenticsRepo(config);
  const catalog = await readCatalog(agenticsRepoDir);
  const name = args.positionals[0];
  const reinstallScope = getScope(args);

  if (name !== undefined) {
    await updatePackageInAgenticsRepo(
      agenticsRepoDir,
      catalog,
      name,
      args.force,
      reinstallScope,
    );
    await writeCatalog(agenticsRepoDir, catalog);
    if (!(await pushAgenticsRepoChanges(agenticsRepoDir, `update ${name}`))) {
      return 1;
    }

    await reinstallInScopeIfPresent(
      agenticsRepoDir,
      catalog,
      name,
      reinstallScope,
    );
    console.log(`Updated ${name}`);
    return 0;
  }

  const summary = await updateAllPackages(
    agenticsRepoDir,
    catalog,
    args.force,
    reinstallScope,
  );

  if (summary.failed.length === 0 && summary.updated.length > 0) {
    await writeCatalog(agenticsRepoDir, catalog);
    if (!(await pushAgenticsRepoChanges(agenticsRepoDir, "update jawfish"))) {
      printBulkUpdateSummary(summary);
      return 1;
    }

    await Promise.all(
      summary.updated.map((updatedName) =>
        reinstallInScopeIfPresent(
          agenticsRepoDir,
          catalog,
          updatedName,
          reinstallScope,
        ),
      ),
    );
  }

  printBulkUpdateSummary(summary);
  return summary.failed.length > 0 ? 1 : 0;
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

  catalog.jawfish[name] = {
    description: "",
    path: packagePath,
    type,
    upstream: source,
  };

  return { imported: true, name };
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
    assertSupportedConfiguredTool(entry.tool, `manifest entry "${name}"`);
  }

  return entry;
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

async function resolveAgenticsRepo(config: JawfishConfig): Promise<string> {
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    const agenticsRepoDir = managedAgenticsRepoPath();
    await initializeLocalManagedAgenticsRepo(agenticsRepoDir);
    config.agenticsRepo = agenticsRepoDir;
    await saveConfig(config);
    return agenticsRepoDir;
  }

  const configured = isAbsolute(config.agenticsRepo)
    ? config.agenticsRepo
    : resolve(process.cwd(), config.agenticsRepo);

  if (resolve(configured) === resolve(deprecatedAgenticsRepoPath())) {
    throw new Error(
      `Nested agentics repo is no longer supported: ${configured}\n` +
        `Move the repo to ${managedAgenticsRepoPath()} and update ${configPath()}.`,
    );
  }

  if ((await exists(configured)) && !(await isBareRepository(configured))) {
    await ensureAgenticsRepoIgnore(configured);
    return configured;
  }

  const agenticsRepoDir = managedAgenticsRepoPath();
  if (await exists(join(agenticsRepoDir, ".git"))) {
    await configureAgenticsRepoGitUser(agenticsRepoDir);
    await ensureAgenticsRepoIgnore(agenticsRepoDir);
    return agenticsRepoDir;
  }

  await initializeManagedAgenticsRepo(config.agenticsRepo, agenticsRepoDir);
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
  return agenticsRepoDir;
}

async function initializeLocalManagedAgenticsRepo(agenticsRepoDir: string): Promise<void> {
  await mkdir(agenticsRepoDir, { recursive: true });
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    await runCommand("git", ["init"], agenticsRepoDir);
  }

  await configureAgenticsRepoGitUser(agenticsRepoDir);
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function initializeManagedAgenticsRepo(
  source: string,
  agenticsRepoDir: string,
): Promise<void> {
  await mkdir(agenticsRepoDir, { recursive: true });
  await runCommand("git", ["init"], agenticsRepoDir);
  await configureAgenticsRepoGitUser(agenticsRepoDir);
  await runCommand("git", ["remote", "add", "origin", source], agenticsRepoDir);
  await runCommand("git", ["fetch", "origin"], agenticsRepoDir);

  const branch = await remoteDefaultBranch(agenticsRepoDir);
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
}

async function remoteDefaultBranch(agenticsRepoDir: string): Promise<string> {
  const result = await runCommand(
    "git",
    ["ls-remote", "--symref", "origin", "HEAD"],
    agenticsRepoDir,
  );
  const match = /^ref: refs\/heads\/([^\t]+)\tHEAD$/mu.exec(result.stdout);
  if (match === null) {
    throw new Error("Could not determine agentics repo default branch");
  }

  return match[1];
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
  agenticsRepoDir: string,
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
      path: compactHomePath(resolveInside(agenticsRepoDir, entry.path)),
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
        assertAllowedOption(command, arg);
        parsed.force = true;
        break;
      case "-g":
      case "--global":
        assertAllowedOption(command, arg);
        parsed.global = true;
        break;
      case "-h":
      case "--help":
        assertAllowedOption(command, arg);
        parsed.help = true;
        break;
      case "-y":
      case "--yes":
        assertAllowedOption(command, arg);
        parsed.yes = true;
        break;
      case "--raw":
        assertAllowedOption(command, arg);
        parsed.raw = true;
        break;
      case "--name": {
        assertAllowedOption(command, arg);
        const name = args[index + 1];
        if (name === undefined) {
          throw new Error(missingOptionValueMessage(command, "--name"));
        }

        parsed.name = name;
        index += 1;
        break;
      }
      case "--type": {
        assertAllowedOption(command, arg);
        const type = args[index + 1];
        if (type === undefined) {
          throw new Error(missingOptionValueMessage(command, "--type"));
        }

        parsed.type = type;
        index += 1;
        break;
      }
      case "--installed": {
        assertAllowedOption(command, arg);
        const installed = args[index + 1];
        if (installed === undefined) {
          throw new Error(missingOptionValueMessage(command, "--installed"));
        }

        parsed.installed = installed;
        index += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(optionErrorMessage(command, "Unknown option", arg));
        }

        parsed.positionals.push(arg);
        break;
    }
  }

  return parsed;
}

function assertAllowedOption(command: CommandName, option: string): void {
  if (!commandOptions[command].includes(option)) {
    throw new Error(optionErrorMessage(command, "Unsupported option", option));
  }
}

function missingOptionValueMessage(
  command: CommandName,
  option: string,
): string {
  return `${option} requires a value\n${usageLine(command)}`;
}

function optionErrorMessage(
  command: CommandName,
  message: string,
  option: string,
): string {
  return `${message}: ${option}\n${usageLine(command)}`;
}

function usageLine(command: CommandName): string {
  return `Usage: ${commandSpecs[command].usage}`;
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

async function syncAgenticsRepo(agenticsRepoDir: string): Promise<void> {
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


if (await isMainModule()) {
  process.exitCode = await run(process.argv.slice(2));
}
