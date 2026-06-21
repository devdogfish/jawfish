import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createBareRemote,
  createCliTestContext,
  createGitRepository,
  git,
  runAgentics,
  type CliTestContext,
} from "./helpers/cli.ts";

const contexts: CliTestContext[] = [];

async function setup(): Promise<CliTestContext> {
  const context = await createCliTestContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe("agentics CLI", () => {
  test("prints root help and command help for the initial surface", async () => {
    const context = await setup();

    const rootHelp = await runAgentics(context, ["--help"]);
    assert.equal(rootHelp.exitCode, 0);
    assert.match(rootHelp.stdout, /Usage: agentics <command>/);

    for (const command of ["add", "install", "update", "remove"]) {
      const result = await runAgentics(context, [command, "--help"]);

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`Usage: agentics ${command}`));
    }
  });
});

describe("CLI test harness", () => {
  test("runs commands with temporary home and project directories", async () => {
    const context = await setup();

    assert.notEqual(context.homeDir, context.projectDir);
    assert.ok(context.homeDir.includes(context.rootDir));
    assert.ok(context.projectDir.includes(context.rootDir));

    const result = await runAgentics(context, ["--version"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.trim(), /\d+\.\d+\.\d+/);
  });

  test("creates temporary git repositories and remotes", async () => {
    const context = await setup();
    const repoDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");

    await createGitRepository(repoDir);
    await createBareRemote(remoteDir);
    await git(repoDir, ["remote", "add", "origin", remoteDir]);
    await git(repoDir, ["push", "-u", "origin", "HEAD"]);

    const bareState = await git(remoteDir, ["rev-parse", "--is-bare-repository"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);

    assert.equal(bareState.stdout.trim(), "true");
    assert.match(remoteHead.stdout.trim(), /^[a-f0-9]{40}$/);
  });
});
