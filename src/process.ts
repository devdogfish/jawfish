import { spawn } from "node:child_process";

export interface CommandResult {
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

export async function runCommand(
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
