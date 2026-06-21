import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function writeAgenticsConfig(
  context: CliTestContext,
  libraryDir: string,
): Promise<void> {
  const configDir = join(context.homeDir, ".config", "agentics");

  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        allowedTools: ["codex"],
        contentLibrary: libraryDir,
        defaultTool: "codex",
      },
      null,
      2,
    ),
  );
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe("agentics CLI", () => {
  test("adds a catalog skill to the current project for the default tool", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(libraryDir, "catalog.json"),
      JSON.stringify(
        {
          agentics: {
            focus: {
              description: "Focus workflow",
              path: "skills/focus",
              type: "skill",
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# Focus\n\nUse focused execution.\n",
    );
    await writeAgenticsConfig(context, libraryDir);

    const result = await runAgentics(context, ["add", "focus"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Added focus to project/);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n\nUse focused execution.\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(context.projectDir, "agentics.json"), "utf8")),
      {
        agentics: {
          focus: {
            tool: "codex",
          },
        },
      },
    );
  });

  test("installs and removes project manifest agentics", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(libraryDir, "catalog.json"),
      JSON.stringify(
        {
          agentics: {
            focus: {
              description: "Focus workflow",
              path: "skills/focus",
              type: "skill",
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(libraryDir, "skills", "focus", "SKILL.md"), "# Focus\n");
    await writeAgenticsConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "agentics.json"),
      JSON.stringify({ agentics: { focus: { tool: "codex" } } }, null, 2),
    );

    const installResult = await runAgentics(context, ["install"]);

    assert.equal(installResult.exitCode, 0);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n",
    );

    const removeResult = await runAgentics(context, ["remove", "focus"]);

    assert.equal(removeResult.exitCode, 0);
    await assert.rejects(
      readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      /ENOENT/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(context.projectDir, "agentics.json"), "utf8")),
      { agentics: {} },
    );
  });

  test("imports a local prompt package, pushes the library, and installs it", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const sourceDir = join(context.rootDir, "daily-brief");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "brief.md"), "Summarize today's work.\n");
    await writeFile(join(sourceDir, "notes.txt"), "Keep it concise.\n");
    await writeAgenticsConfig(context, libraryDir);

    const result = await runAgentics(context, [
      "add",
      join(sourceDir, "brief.md"),
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "prompts", "daily-brief", "notes.txt"),
        "utf8",
      ),
      "Keep it concise.\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(libraryDir, "catalog.json"), "utf8")),
      {
        agentics: {
          "daily-brief": {
            description: "",
            path: "prompts/daily-brief",
            type: "prompt",
            upstream: join(sourceDir, "brief.md"),
          },
        },
      },
    );

    const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
  });

  test("updates an upstream package, removes stale files, pushes, and reinstalls", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const upstreamDir = join(context.rootDir, "upstream-focus");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(libraryDir, "catalog.json"),
      JSON.stringify(
        {
          agentics: {
            focus: {
              description: "Focus workflow",
              path: "skills/focus",
              type: "skill",
              upstream: upstreamDir,
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(libraryDir, "skills", "focus", "SKILL.md"), "# Old\n");
    await writeFile(join(libraryDir, "skills", "focus", "stale.md"), "stale\n");
    await git(libraryDir, ["add", "."]);
    await git(libraryDir, ["commit", "-m", "seed focus"]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(upstreamDir, { recursive: true });
    await writeFile(join(upstreamDir, "SKILL.md"), "# New\n");
    await writeAgenticsConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "agentics.json"),
      JSON.stringify({ agentics: { focus: { tool: "codex" } } }, null, 2),
    );
    await runAgentics(context, ["install"]);

    const result = await runAgentics(context, ["update", "focus"]);

    assert.equal(result.exitCode, 0);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# New\n",
    );
    await assert.rejects(
      readFile(join(libraryDir, "skills", "focus", "stale.md"), "utf8"),
      /ENOENT/,
    );
    const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
  });

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
