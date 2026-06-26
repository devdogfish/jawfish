import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(repoRoot, "src", "main.ts");

export interface CommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export interface CliTestContext {
  homeDir: string;
  projectDir: string;
  rootDir: string;
  cleanup: () => Promise<void>;
}

interface CommandOptions {
  cwd: string;
  env?: Record<string, string>;
}

interface RunJawfishOptions {
  env?: Record<string, string>;
}

export async function createCliTestContext(): Promise<CliTestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), "jawfish-test-"));
  const homeDir = join(rootDir, "home");
  const projectDir = join(rootDir, "project");

  await mkdir(homeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  return {
    homeDir,
    projectDir,
    rootDir,
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
  };
}

export async function runJawfish(
  context: CliTestContext,
  args: string[] = [],
  options: RunJawfishOptions = {},
): Promise<CommandResult> {
  return runCommand("node", ["--experimental-strip-types", cliEntry, ...args], {
    cwd: context.projectDir,
    env: {
      JAWFISH_HOME: context.homeDir,
      CODEX_HOME: join(context.homeDir, ".codex"),
      HOME: context.homeDir,
      XDG_CONFIG_HOME: join(context.homeDir, ".config"),
      ...options.env,
    },
  });
}

export async function createGitRepository(
  repositoryDir: string,
): Promise<void> {
  await mkdir(repositoryDir, { recursive: true });
  await git(repoRoot, ["init", repositoryDir]);
  await git(repositoryDir, [
    "config",
    "user.email",
    "jawfish-test@example.com",
  ]);
  await git(repositoryDir, ["config", "user.name", "Jawfish Test"]);
  await writeFile(join(repositoryDir, "README.md"), "# Test repository\n");
  await git(repositoryDir, ["add", "README.md"]);
  await git(repositoryDir, ["commit", "-m", "initial commit"]);
}

export async function createBareRemote(remoteDir: string): Promise<void> {
  await mkdir(remoteDir, { recursive: true });
  await git(repoRoot, ["init", "--bare", remoteDir]);
}

export async function git(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand("git", args, { cwd });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode})\n${result.stderr}`,
    );
  }

  return result;
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    waitForExit(child),
  ]);

  return { exitCode, stderr, stdout };
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
