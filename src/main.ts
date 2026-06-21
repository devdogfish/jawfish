#!/usr/bin/env -S node --experimental-strip-types
import { cancel, isCancel, select } from "@clack/prompts";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
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

const version = "0.1.0";
const catalogFile = "catalog.json";
const projectManifestFile = "agentics.json";
const managedMarkerFile = ".agentics-managed.json";
const defaultTools = ["codex", "claude-code", "hermes"] as const;

type AgenticType = "skill" | "agent" | "prompt";
type InstallScope = "project" | "global";

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
  const libraryDir = requireContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);

  if (!Object.hasOwn(catalog.agentics, source)) {
    const imported = await importPackage(libraryDir, catalog, source, args.name);
    const pushResult = await commitAndPush(libraryDir, `add ${imported}`);
    if (!pushResult.ok) {
      printPushFailure(pushResult.error);
      return 1;
    }

    await writeCatalog(libraryDir, catalog);
    await installOne(libraryDir, catalog, imported, scope, config);
    console.log(`Added ${imported} to ${scope}`);
    return 0;
  }

  await installOne(libraryDir, catalog, source, scope, config);
  console.log(`Added ${source} to ${scope}`);
  return 0;
}

async function installCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig();
  const libraryDir = requireContentLibrary(config);
  await syncLibrary(libraryDir);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);

  for (const name of Object.keys(manifest.agentics)) {
    await materialize(libraryDir, catalog, name, scope, manifest.agentics[name].tool);
  }

  console.log(`Installed ${Object.keys(manifest.agentics).length} agentics to ${scope}`);
  return 0;
}

async function removeCommand(args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (name === undefined) {
    console.error("Usage: agentics remove [options] <name>");
    return 1;
  }

  const config = await loadConfig();
  const libraryDir = requireContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const scope = getScope(args);
  const manifest = await readManifest(scope);
  const manifestEntry = manifest.agentics[name];
  const catalogEntry = catalog.agentics[name];

  if (manifestEntry !== undefined && catalogEntry !== undefined) {
    await removeMaterialized(name, catalogEntry.type, scope, manifestEntry.tool);
  }

  delete manifest.agentics[name];
  await writeManifest(scope, manifest);
  console.log(`Removed ${name} from ${scope}`);
  return 0;
}

async function updateCommand(args: ParsedArgs): Promise<number> {
  const config = await loadConfig();
  const libraryDir = requireContentLibrary(config);
  const catalog = await readCatalog(libraryDir);
  const name = args.positionals[0];

  if (name !== undefined) {
    await updatePackage(libraryDir, catalog, name, args.force);
    await writeCatalog(libraryDir, catalog);
    const pushResult = await commitAndPush(libraryDir, `update ${name}`);
    if (!pushResult.ok) {
      printPushFailure(pushResult.error);
      return 1;
    }

    await reinstallIfPresent(libraryDir, catalog, name);
    console.log(`Updated ${name}`);
    return 0;
  }

  const updated: string[] = [];
  for (const candidate of Object.keys(catalog.agentics)) {
    if (catalog.agentics[candidate].upstream === undefined) {
      continue;
    }

    await updatePackage(libraryDir, catalog, candidate, args.force);
    updated.push(candidate);
  }

  if (updated.length > 0) {
    await writeCatalog(libraryDir, catalog);
    const pushResult = await commitAndPush(libraryDir, "update agentics");
    if (!pushResult.ok) {
      printPushFailure(pushResult.error);
      return 1;
    }

    await Promise.all(
      updated.map((updatedName) => reinstallIfPresent(libraryDir, catalog, updatedName)),
    );
  }

  console.log(`Updated ${updated.length} agentics`);
  return 0;
}

async function installOne(
  libraryDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  config: Config,
): Promise<void> {
  const tool = await resolveTool(config);
  await materialize(libraryDir, catalog, name, scope, tool);

  const manifest = await readManifest(scope);
  manifest.agentics[name] = { tool };
  await writeManifest(scope, manifest);
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
  const destination = destinationPath(name, entry.type, scope, tool);
  await ensureManagedDestination(destination);
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });

  const sourceStat = await stat(sourcePath);
  if (sourceStat.isDirectory()) {
    await cp(sourcePath, destination, { recursive: true });
  } else {
    await cp(sourcePath, join(destination, basename(sourcePath)));
  }

  await writeJson(join(destination, managedMarkerFile), {
    name,
    tool,
    type: entry.type,
  });
}

async function removeMaterialized(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
): Promise<void> {
  const destination = destinationPath(name, type, scope, tool);
  await rm(destination, { force: true, recursive: true });
}

async function ensureManagedDestination(destination: string): Promise<void> {
  if (!(await exists(destination))) {
    return;
  }

  if (!(await exists(join(destination, managedMarkerFile)))) {
    throw new Error(
      `Refusing to overwrite unmanaged destination: ${destination}\n` +
        "Remove it or move it aside, then retry.",
    );
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

  if (Object.hasOwn(catalog.agentics, name)) {
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

  await writeCatalog(libraryDir, catalog);
  return name;
}

async function acquireSource(
  source: string,
): Promise<{ entryFile?: string; inferredName: string; packagePath: string }> {
  if (isUrl(source)) {
    const tempDir = await mkdtemp(join(tmpdir(), "agentics-source-"));
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
    }

    const url = new URL(source);
    const fileName = basename(url.pathname) || "agentic.md";
    const filePath = join(tempDir, fileName);
    await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    return {
      entryFile: filePath,
      inferredName: basename(dirname(url.pathname)) || inferPackageName(fileName),
      packagePath: tempDir,
    };
  }

  const localPath = resolve(process.cwd(), source);
  const sourceStat = await stat(localPath);
  const packagePath = sourceStat.isDirectory() ? localPath : dirname(localPath);
  return {
    entryFile: sourceStat.isDirectory() ? undefined : localPath,
    inferredName: inferPackageName(packagePath),
    packagePath,
  };
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

async function reinstallIfPresent(
  libraryDir: string,
  catalog: Catalog,
  name: string,
): Promise<void> {
  for (const scope of ["project", "global"] as const) {
    const manifest = await readManifest(scope);
    const entry = manifest.agentics[name];
    if (entry !== undefined) {
      await materialize(libraryDir, catalog, name, scope, entry.tool);
    }
  }
}

async function resolveTool(config: Config): Promise<string> {
  const allowedTools = config.allowedTools.length > 0 ? config.allowedTools : [...defaultTools];
  config.allowedTools = allowedTools;

  if (config.defaultTool !== undefined) {
    return config.defaultTool;
  }

  const selected = await promptForTool(allowedTools);
  if (selected === "") {
    throw new Error("No default tool selected");
  }

  config.defaultTool = selected;
  await writeConfig(config);
  return selected;
}

async function loadConfig(): Promise<Config> {
  const path = configPath();
  if (!(await exists(path))) {
    const config = { allowedTools: [...defaultTools] };
    await writeConfig(config);
    return config;
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Config>;
  return {
    allowedTools: parsed.allowedTools ?? [...defaultTools],
    contentLibrary: parsed.contentLibrary,
    defaultTool: parsed.defaultTool,
  };
}

async function writeConfig(config: Config): Promise<void> {
  await writeJson(configPath(), config);
}

function requireContentLibrary(config: Config): string {
  if (config.contentLibrary === undefined || config.contentLibrary === "") {
    throw new Error(
      `Missing contentLibrary in ${configPath()}\n` +
        "Set it to your agentics content library path or clone URL.",
    );
  }

  return isAbsolute(config.contentLibrary)
    ? config.contentLibrary
    : resolve(process.cwd(), config.contentLibrary);
}

async function readCatalog(libraryDir: string): Promise<Catalog> {
  const path = join(libraryDir, catalogFile);
  if (!(await exists(path))) {
    return { agentics: {} };
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Catalog>;
  return { agentics: parsed.agentics ?? {} };
}

async function writeCatalog(libraryDir: string, catalog: Catalog): Promise<void> {
  await writeJson(join(libraryDir, catalogFile), catalog);
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

function destinationPath(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
): string {
  const folder = typeFolder(type);

  switch (tool) {
    case "codex":
      return join(scopeRoot(scope), ".codex", folder, name);
    case "claude-code":
      return join(scopeRoot(scope), ".claude", folder, name);
    case "hermes":
      return join(scopeRoot(scope), ".hermes", folder, name);
    default:
      throw new Error(`Unsupported tool: ${tool}`);
  }
}

function typeFolder(type: AgenticType): string {
  switch (type) {
    case "agent":
      return "agents";
    case "prompt":
      return "prompts";
    case "skill":
      return "skills";
  }
}

async function inferType(
  packagePath: string,
  entryFile: string | undefined,
): Promise<AgenticType> {
  const skillPath = join(packagePath, "SKILL.md");
  const agentPath = join(packagePath, "AGENT.md");

  if (await exists(skillPath)) {
    return "skill";
  }

  if (await exists(agentPath)) {
    return "agent";
  }

  if (entryFile !== undefined && promptExtensions.has(extname(entryFile))) {
    return "prompt";
  }

  throw new Error(
    `Could not infer agentic type for ${packagePath}. ` +
      "Add SKILL.md, AGENT.md, or import a prompt-like file.",
  );
}

function inferPackageName(packagePath: string): string {
  return basename(packagePath).replace(/\.[^.]+$/, "");
}

function configPath(): string {
  return join(xdgConfigHome(), "agentics", "config.json");
}

function manifestPath(scope: InstallScope): string {
  if (scope === "project") {
    return join(process.cwd(), projectManifestFile);
  }

  return join(agenticsHome(), projectManifestFile);
}

function scopeRoot(scope: InstallScope): string {
  return scope === "project" ? process.cwd() : homeDir();
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
  if (await exists(join(libraryDir, ".git"))) {
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
): Promise<{ ok: true } | { ok: false; error: string }> {
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

function printPushFailure(error: string): void {
  console.error("Library commit was created, but push failed.");
  console.error(error.trim());
  console.error("Recover with: git -C <contentLibrary> push");
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
