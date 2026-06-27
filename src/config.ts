import { cancel, isCancel, select } from "@clack/prompts";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorHasCode, errorMessage } from "./errors.ts";
import {
  assertSupportedTool,
  supportedTools,
  type InstallScope,
  type ToolPaths,
} from "./tool-adapters.ts";

export const defaultSupportedTools = supportedTools;
const projectManifestFile = "jawfish.json";

export interface JawfishConfig {
  agenticsRepo?: string;
  autoScanRepoSkills?: boolean;
  defaultTool?: string;
}

interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  promptForDefaultTool?: (supportedTools: string[]) => Promise<string>;
  promptForMissingDefaultTool?: boolean;
}

interface SaveConfigOptions {
  env?: NodeJS.ProcessEnv;
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? homedir();
}

export function jawfishHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.JAWFISH_HOME ?? join(homeDir(env), ".jawfish");
}

export function configPath(home = jawfishHome()): string {
  return join(home, "config.json");
}

export function legacyConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(xdgConfigHome(env), "jawfish", "config.json");
}

export async function existingConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const primary = configPath(jawfishHome(env));
  if (await exists(primary)) {
    return primary;
  }

  const legacy = legacyConfigPath(env);
  if (await exists(legacy)) {
    return legacy;
  }

  return undefined;
}

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<JawfishConfig> {
  const env = options.env ?? process.env;
  const filePath = await existingConfigPath(env);
  const existing = filePath === undefined ? {} : await readConfig(filePath);
  const config: JawfishConfig = {};
  let changed =
    filePath === undefined || existing.allowedTools !== undefined;

  if (existing.agenticsRepo !== undefined) {
    config.agenticsRepo = existing.agenticsRepo;
  }
  if (existing.autoScanRepoSkills !== undefined) {
    config.autoScanRepoSkills = existing.autoScanRepoSkills;
  }
  if (existing.defaultTool !== undefined) {
    config.defaultTool = existing.defaultTool;
  }

  if (config.agenticsRepo === undefined && env.JAWFISH_AGENTICS_REPO) {
    config.agenticsRepo = env.JAWFISH_AGENTICS_REPO;
    changed = true;
  }

  if (config.defaultTool === undefined && env.JAWFISH_DEFAULT_TOOL !== undefined) {
    assertSupportedTool(env.JAWFISH_DEFAULT_TOOL, "JAWFISH_DEFAULT_TOOL");
    config.defaultTool = env.JAWFISH_DEFAULT_TOOL;
    changed = true;
  } else if (
    config.defaultTool === undefined &&
    options.promptForMissingDefaultTool !== false
  ) {
    config.defaultTool = await chooseDefaultTool(options, env);
    changed = true;
  } else {
    if (config.defaultTool !== undefined) {
      assertSupportedTool(config.defaultTool, "config defaultTool");
    }
  }

  if (changed) {
    await saveConfig(config, { env });
  }

  return config;
}

export async function saveConfig(
  config: JawfishConfig,
  options: SaveConfigOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  await writeConfig(configPath(jawfishHome(env)), config);
}

export async function promptForTool(allowedTools: string[]): Promise<string> {
  const selected = await select({
    message: "Select default tool",
    options: allowedTools.map((tool) => ({ label: tool, value: tool })),
  });

  if (isCancel(selected)) {
    cancel("No tool selected");
    throw new Error("No tool selected");
  }

  return selected;
}

async function chooseDefaultTool(
  options: LoadConfigOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const envDefault = env.JAWFISH_DEFAULT_TOOL;

  if (envDefault !== undefined) {
    assertSupportedTool(envDefault, "JAWFISH_DEFAULT_TOOL");
    return envDefault;
  }

  const selected = await (options.promptForDefaultTool ?? promptForTool)([
    ...supportedTools,
  ]);
  assertSupportedTool(selected, "selected default tool");
  return selected;
}

type RawConfig = Partial<JawfishConfig> & { allowedTools?: unknown };

async function readConfig(path: string): Promise<RawConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return {};
    }

    throw new Error(`Invalid config at ${path}: ${errorMessage(error)}`);
  }
}

async function writeConfig(path: string, config: JawfishConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const persisted: JawfishConfig = {};
  if (config.agenticsRepo !== undefined) {
    persisted.agenticsRepo = config.agenticsRepo;
  }
  if (config.autoScanRepoSkills !== undefined) {
    persisted.autoScanRepoSkills = config.autoScanRepoSkills;
  }
  if (config.defaultTool !== undefined) {
    persisted.defaultTool = config.defaultTool;
  }

  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`);
}

export function managedAgenticsRepoPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(jawfishHome(env), "agentics");
}

export function deprecatedAgenticsRepoPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(jawfishHome(env), "repo");
}

export function manifestPath(
  scope: InstallScope,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (scope === "project") {
    return join(cwd, projectManifestFile);
  }

  return join(jawfishHome(env), projectManifestFile);
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homeDir(env), ".codex");
}

export function opencodeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.OPENCODE_CONFIG_DIR ?? join(homeDir(env), ".config", "opencode");
}

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), ".pi", "agent");
}

export function toolPaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ToolPaths {
  return {
    codexHome: codexHome(env),
    homeDir: homeDir(env),
    opencodeConfigDir: opencodeConfigDir(env),
    piAgentDir: piAgentDir(env),
    projectDir: cwd,
  };
}

function xdgConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CONFIG_HOME ?? join(homeDir(env), ".config");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}
