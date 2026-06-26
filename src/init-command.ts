import { cancel, isCancel, select, text } from "@clack/prompts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  configureAgenticsRepoGitUser,
  ensureAgenticsRepoIgnore,
  inspectAgenticsRepo,
  type AgenticsRepoInspection,
} from "./agentics-repo.ts";
import {
  assertSupportedConfiguredTool,
  configPath,
  defaultSupportedTools,
  deprecatedAgenticsRepoPath,
  existingConfigPath,
  jawfishHome,
  loadConfig,
  managedAgenticsRepoPath,
  manifestPath,
  saveConfig,
  type JawfishConfig,
} from "./config.ts";
import { exists } from "./files.ts";
import { runCommand } from "./process.ts";

interface InitCommandArgs {
  force: boolean;
  global: boolean;
  name?: string;
  positionals: string[];
  raw: boolean;
  type?: string;
  yes: boolean;
}

type AgenticsRepoMode = "link" | "local";
type GitRepositoryState = "created" | "existing";

export interface InitCommandPrompts {
  inputAgenticsRepo: () => Promise<string>;
  selectAgenticsRepoMode: () => Promise<AgenticsRepoMode>;
  selectDefaultTool: (supportedTools: readonly string[]) => Promise<string>;
}

interface InitCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts?: InitCommandPrompts;
}

interface InitContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompts: InitCommandPrompts;
}

export async function initCommand(
  args: InitCommandArgs,
  options: InitCommandOptions = {},
): Promise<number> {
  const context = initContext(options);

  if (
    args.force ||
    args.global ||
    args.name !== undefined ||
    args.positionals.length > 0 ||
    args.raw ||
    args.type !== undefined
  ) {
    console.error("Usage: jawfish init [options]");
    return 1;
  }

  const configFile = await existingConfigPath(context.env);
  if (configFile === undefined) {
    const config = args.yes
      ? await createMachineSetup(context)
      : await createInteractiveMachineSetup(context);
    console.log(`Initialized jawfish at ${configPath(jawfishHome(context.env))}`);
    console.log(`Agentics repo: ${config.agenticsRepo}`);
    await printAgenticsRepoInspection(config.agenticsRepo, context);
    return 0;
  }

  const config = await validateMachineSetup(context);
  await ensureProjectManifest(context);
  console.log(`Initialized project at ${manifestPath("project", context.env, context.cwd)}`);
  await printAgenticsRepoInspection(config.agenticsRepo, context);
  return 0;
}

function initContext(options: InitCommandOptions): InitContext {
  return {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    prompts: options.prompts ?? defaultInitPrompts,
  };
}

const defaultInitPrompts: InitCommandPrompts = {
  inputAgenticsRepo: promptForAgenticsRepo,
  selectAgenticsRepoMode: promptForAgenticsRepoMode,
  selectDefaultTool: promptForDefaultTool,
};

async function createMachineSetup(context: InitContext): Promise<JawfishConfig> {
  const defaultTool = context.env.JAWFISH_DEFAULT_TOOL ?? firstSupportedTool();
  assertSupportedConfiguredTool(defaultTool, "JAWFISH_DEFAULT_TOOL");

  const agenticsRepo =
    context.env.JAWFISH_AGENTICS_REPO ?? managedAgenticsRepoPath(context.env);
  const config: JawfishConfig = { agenticsRepo, defaultTool };

  await saveConfig(config, { env: context.env });
  await initializeLocalAgenticsRepo(agenticsRepo, context);
  await ensureGlobalManifest(context);
  return config;
}

async function createInteractiveMachineSetup(
  context: InitContext,
): Promise<JawfishConfig> {
  const defaultTool = await context.prompts.selectDefaultTool(defaultSupportedTools);
  assertSupportedConfiguredTool(defaultTool, "selected default tool");

  const repoMode = await context.prompts.selectAgenticsRepoMode();
  const agenticsRepo = await resolveAgenticsRepoSelection(repoMode, context);

  const config: JawfishConfig = { agenticsRepo, defaultTool };
  await prepareAgenticsRepo(agenticsRepo, repoMode, context);
  await ensureGlobalManifest(context);
  await saveConfig(config, { env: context.env });
  return config;
}

function firstSupportedTool(): string {
  const [tool] = defaultSupportedTools;
  if (tool === undefined) {
    throw new Error("No supported tools configured");
  }

  return tool;
}

async function resolveAgenticsRepoSelection(
  mode: AgenticsRepoMode,
  context: InitContext,
): Promise<string> {
  if (mode === "local") {
    return managedAgenticsRepoPath(context.env);
  }

  return context.prompts.inputAgenticsRepo();
}

async function prepareAgenticsRepo(
  agenticsRepo: string,
  mode: AgenticsRepoMode,
  context: InitContext,
): Promise<void> {
  if (mode === "local") {
    await initializeLocalAgenticsRepo(agenticsRepo, context);
    return;
  }

  const linkedPath = resolveConfiguredPath(agenticsRepo, context.cwd);
  const linkedPathExists = await exists(linkedPath);
  if (linkedPathExists && !(await isBareRepository(linkedPath))) {
    await initializeLocalAgenticsRepo(linkedPath, context);
    return;
  }

  if (linkedPathExists || looksLikeGitUrl(agenticsRepo)) {
    await initializeManagedAgenticsRepo(
      agenticsRepo,
      managedAgenticsRepoPath(context.env),
    );
    return;
  }

  throw new Error(`Agentics repo path not found: ${agenticsRepo}`);
}

async function initializeLocalAgenticsRepo(
  agenticsRepo: string,
  context: InitContext,
): Promise<void> {
  const agenticsRepoDir = resolveConfiguredPath(agenticsRepo, context.cwd);

  await ensureGitRepository(agenticsRepoDir);
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function initializeManagedAgenticsRepo(
  source: string,
  agenticsRepoDir: string,
): Promise<void> {
  const gitRepositoryState = await ensureGitRepository(agenticsRepoDir);
  if (gitRepositoryState === "existing") {
    await runCommand("git", ["remote", "set-url", "origin", source], agenticsRepoDir);
  } else {
    await runCommand("git", ["remote", "add", "origin", source], agenticsRepoDir);
  }

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
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function ensureGitRepository(
  agenticsRepoDir: string,
): Promise<GitRepositoryState> {
  await mkdir(agenticsRepoDir, { recursive: true });
  const hadGitRepository = await exists(join(agenticsRepoDir, ".git"));
  if (!hadGitRepository) {
    await runCommand("git", ["init"], agenticsRepoDir);
  }

  await configureAgenticsRepoGitUser(agenticsRepoDir);
  return hadGitRepository ? "existing" : "created";
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

async function isBareRepository(path: string): Promise<boolean> {
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

async function ensureGlobalManifest(context: InitContext): Promise<void> {
  await ensureManifest(manifestPath("global", context.env, context.cwd));
}

async function ensureProjectManifest(context: InitContext): Promise<void> {
  await ensureManifest(manifestPath("project", context.env, context.cwd));
}

async function validateMachineSetup(context: InitContext): Promise<JawfishConfig> {
  const config = await loadConfig({
    env: context.env,
    promptForMissingDefaultTool: false,
  });
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    return config;
  }

  const configured = resolveConfiguredPath(config.agenticsRepo, context.cwd);
  if (resolve(configured) !== resolve(deprecatedAgenticsRepoPath(context.env))) {
    return config;
  }

  throw new Error(
    `Nested agentics repo is no longer supported: ${configured}\n` +
      `Move the repo to ${managedAgenticsRepoPath(context.env)} and update ` +
      `${configPath(jawfishHome(context.env))}.`,
  );
}

async function ensureManifest(path: string): Promise<void> {
  if (await exists(path)) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ jawfish: {} }, null, 2)}\n`);
}

async function printAgenticsRepoInspection(
  agenticsRepo: string | undefined,
  context: InitContext,
): Promise<void> {
  if (agenticsRepo === undefined || agenticsRepo === "") {
    console.log("Agentics repo inspection");
    console.log("Catalog: none");
    console.log("Counts: 0 skills, 0 agents, 0 prompts");
    console.log("Usable: none");
    return;
  }

  const agenticsRepoDir = await inspectionAgenticsRepoDir(agenticsRepo, context);
  const inspection = await inspectAgenticsRepo(agenticsRepoDir);
  printInspection(inspection);
}

async function inspectionAgenticsRepoDir(
  agenticsRepo: string,
  context: InitContext,
): Promise<string> {
  const configured = resolveConfiguredPath(agenticsRepo, context.cwd);
  if ((await exists(configured)) && !(await isBareRepository(configured))) {
    return configured;
  }

  return managedAgenticsRepoPath(context.env);
}

function printInspection(inspection: AgenticsRepoInspection): void {
  console.log("Agentics repo inspection");
  console.log(`Catalog: ${inspection.catalogPath ?? "none"}`);
  console.log(
    `Counts: ${formatCount(inspection.counts.skill, "skill")}, ` +
      `${formatCount(inspection.counts.agent, "agent")}, ` +
      `${formatCount(inspection.counts.prompt, "prompt")}`,
  );
  console.log(`Usable: ${formatNames(inspection.usableNames)}`);

  if (
    inspection.usableNames.length === 0 &&
    inspection.broken.length === 0 &&
    inspection.skipped.length === 0
  ) {
    console.log("Repo is empty. Add or import agentics to make them selectable.");
  }

  for (const issue of inspection.broken) {
    console.log(`Broken: ${issue.target}: ${issue.reason}`);
  }
  for (const issue of inspection.skipped) {
    console.log(`Skipped: ${issue.target}: ${issue.reason}`);
  }
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatNames(names: string[]): string {
  if (names.length === 0) {
    return "none";
  }

  return names.join(", ");
}

function resolveConfiguredPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function looksLikeGitUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^@\s]+@[^:\s]+:.+/.test(value);
}

async function promptForDefaultTool(tools: readonly string[]): Promise<string> {
  const selected = await select({
    message: "Select default tool",
    options: tools.map((tool) => ({ label: tool, value: tool })),
  });

  if (isCancel(selected)) {
    cancel("No tool selected");
    throw new Error("No tool selected");
  }

  return selected;
}

async function promptForAgenticsRepoMode(): Promise<AgenticsRepoMode> {
  const selected = await select({
    message: "Set up agentics repo",
    options: [
      { label: "Create local repo", value: "local" },
      { label: "Link existing path or git URL", value: "link" },
    ],
  });

  if (isCancel(selected)) {
    cancel("No agentics repo selected");
    throw new Error("No agentics repo selected");
  }

  return selected;
}

async function promptForAgenticsRepo(): Promise<string> {
  const selected = await text({
    message: "Agentics repo path or git URL",
    validate: (value) =>
      (value ?? "").trim() === "" ? "Enter a local path or git URL" : undefined,
  });

  if (isCancel(selected) || selected === undefined) {
    cancel("No agentics repo selected");
    throw new Error("No agentics repo selected");
  }

  return selected.trim();
}
