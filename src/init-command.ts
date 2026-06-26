import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

const agenticsRepoIgnoreEntries = ["config.json", "jawfish.json"];

interface InitCommandArgs {
  force: boolean;
  global: boolean;
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

  await configureGitUser(agenticsRepoDir);
  await ensureAgenticsRepoIgnore(agenticsRepoDir);
}

async function configureGitUser(agenticsRepoDir: string): Promise<void> {
  const email = await runCommand(
    "git",
    ["config", "--get", "user.email"],
    agenticsRepoDir,
    false,
  );
  if (email.exitCode !== 0 || email.stdout.trim() === "") {
    await runCommand(
      "git",
      ["config", "user.email", "jawfish@example.invalid"],
      agenticsRepoDir,
    );
  }

  const name = await runCommand(
    "git",
    ["config", "--get", "user.name"],
    agenticsRepoDir,
    false,
  );
  if (name.exitCode !== 0 || name.stdout.trim() === "") {
    await runCommand("git", ["config", "user.name", "Jawfish"], agenticsRepoDir);
  }
}

async function ensureAgenticsRepoIgnore(agenticsRepoDir: string): Promise<void> {
  const ignorePath = join(agenticsRepoDir, ".gitignore");
  const existing = (await exists(ignorePath))
    ? await readFile(ignorePath, "utf8")
    : "";
  const existingEntries = new Set(
    existing.split("\n").map((line) => line.trim()),
  );
  const missing = agenticsRepoIgnoreEntries.filter(
    (entry) => !existingEntries.has(entry),
  );
  if (missing.length === 0) {
    return;
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(ignorePath, `${existing}${separator}${missing.join("\n")}\n`);
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
