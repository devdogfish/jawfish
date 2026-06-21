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

export async function createCliTestContext(): Promise<CliTestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), "agentics-test-"));
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

export async function runAgentics(
  context: CliTestContext,
  args: string[] = [],
): Promise<CommandResult> {
  return runCommand("node", ["--experimental-strip-types", cliEntry, ...args], {
    cwd: context.projectDir,
    env: {
      AGENTICS_HOME: context.homeDir,
      HOME: context.homeDir,
      XDG_CONFIG_HOME: join(context.homeDir, ".config"),
    },
  });
}

export async function createGitRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await runCommand("git", ["init", path], { cwd: repoRoot });
  await git(path, ["config", "user.email", "agentics-test@example.com"]);
  await git(path, ["config", "user.name", "Agentics Test"]);
  await writeFile(join(path, "README.md"), "# Test repository\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "initial commit"]);
}

export async function createBareRemote(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await runCommand("git", ["init", "--bare", path], { cwd: repoRoot });
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
  options: { cwd: string; env?: Record<string, string> },
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => {
      child.on("close", resolve);
    }),
  ]);

  return { exitCode, stderr, stdout };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";

  for await (const chunk of stream) {
    output += chunk;
  }

  return output;
}
