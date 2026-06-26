import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  configureAgenticsRepoGitUser,
  ensureAgenticsRepoIgnore,
} from "./agentics-repo.ts";
import {
  assertSupportedConfiguredTool,
  configPath,
  defaultSupportedTools,
  deprecatedAgenticsRepoPath,
  existingConfigPath,
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

export async function initCommand(args: InitCommandArgs): Promise<number> {
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

  const configFile = await existingConfigPath();
  if (configFile === undefined) {
    const config = await createMachineSetup();
    console.log(`Initialized jawfish at ${configPath()}`);
    console.log(`Agentics repo: ${config.agenticsRepo}`);
    return 0;
  }

  await validateMachineSetup();
  await ensureProjectManifest();
  console.log(`Initialized project at ${manifestPath("project")}`);
  return 0;
}

async function createMachineSetup(): Promise<JawfishConfig> {
  const defaultTool = process.env.JAWFISH_DEFAULT_TOOL ?? firstSupportedTool();
  assertSupportedConfiguredTool(defaultTool, "JAWFISH_DEFAULT_TOOL");

  const agenticsRepo =
    process.env.JAWFISH_AGENTICS_REPO ?? managedAgenticsRepoPath();
  const config: JawfishConfig = { agenticsRepo, defaultTool };

  await saveConfig(config);
  await initializeLocalAgenticsRepo(agenticsRepo);
  await ensureGlobalManifest();
  return config;
}

function firstSupportedTool(): string {
  const [tool] = defaultSupportedTools;
  if (tool === undefined) {
    throw new Error("No supported tools configured");
  }

  return tool;
}

async function initializeLocalAgenticsRepo(agenticsRepo: string): Promise<void> {
  const agenticsRepoDir = isAbsolute(agenticsRepo)
    ? agenticsRepo
    : resolve(process.cwd(), agenticsRepo);

  await mkdir(agenticsRepoDir, { recursive: true });
  if (!(await exists(join(agenticsRepoDir, ".git")))) {
    await runCommand("git", ["init"], agenticsRepoDir);
  }

  await configureAgenticsRepoGitUser(agenticsRepoDir);
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function ensureGlobalManifest(): Promise<void> {
  await ensureManifest(manifestPath("global"));
}

async function ensureProjectManifest(): Promise<void> {
  await ensureManifest(manifestPath("project"));
}

async function validateMachineSetup(): Promise<void> {
  const config = await loadConfig({ promptForMissingDefaultTool: false });
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    return;
  }

  const configured = isAbsolute(config.agenticsRepo)
    ? config.agenticsRepo
    : resolve(process.cwd(), config.agenticsRepo);
  if (resolve(configured) !== resolve(deprecatedAgenticsRepoPath())) {
    return;
  }

  throw new Error(
    `Nested agentics repo is no longer supported: ${configured}\n` +
      `Move the repo to ${managedAgenticsRepoPath()} and update ${configPath()}.`,
  );
}

async function ensureManifest(path: string): Promise<void> {
  if (await exists(path)) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ jawfish: {} }, null, 2)}\n`);
}
