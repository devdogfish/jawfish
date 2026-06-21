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
import {
  configPath,
  defaultAllowedTools,
  loadConfig,
  type AgenticsConfig,
} from "../src/config.ts";

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

async function writeIndexedFocusSkill(libraryDir: string): Promise<void> {
  await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
  await writeFile(
    join(libraryDir, "index.json"),
    JSON.stringify(
      {
        focus: {
          description: "Focus workflow",
          path: "skills/focus",
          type: "skill",
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

  test("adds a name-keyed catalog skill to Codex project and global directories", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const codexHome = join(context.rootDir, "codex-home");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeAgenticsConfig(context, libraryDir);

    const projectResult = await runAgentics(context, ["add", "focus"], {
      env: { CODEX_HOME: codexHome },
    });
    const globalResult = await runAgentics(context, ["add", "-g", "focus"], {
      env: { CODEX_HOME: codexHome },
    });

    assert.equal(projectResult.exitCode, 0, projectResult.stderr);
    assert.equal(globalResult.exitCode, 0, globalResult.stderr);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n\nUse focused execution.\n",
    );
    assert.equal(
      await readFile(join(codexHome, "skills", "focus", "SKILL.md"), "utf8"),
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
    assert.deepEqual(
      JSON.parse(await readFile(join(context.homeDir, "agentics.json"), "utf8")),
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

  test("creates first-run config with default tools and selected default tool", async () => {
    const context = await setup();
    const remoteDir = await createContentLibraryRemote(context, {
      "demo-skill": {
        type: "skill",
        description: "Demo skill",
        path: "skills/demo-skill",
      },
    });

    const result = await runAgentics(context, ["add", "demo-skill"], {
      env: {
        AGENTICS_CONTENT_LIBRARY: remoteDir,
        AGENTICS_DEFAULT_TOOL: "claude-code",
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const config = JSON.parse(await readFile(configPath(context.homeDir), "utf8"));

    assert.deepEqual(config, {
      contentLibrary: remoteDir,
      allowedTools: ["codex", "claude-code", "hermes"],
      defaultTool: "claude-code",
    });
  });

  test("prompts for a missing default tool and saves the selected tool", async () => {
    const context = await setup();
    let promptedTools: string[] = [];

    const config = await loadConfig({
      env: {
        AGENTICS_HOME: context.homeDir,
      },
      promptForDefaultTool: async (allowedTools) => {
        promptedTools = allowedTools;
        return "hermes";
      },
    });

    assert.deepEqual(promptedTools, [...defaultAllowedTools]);
    assert.deepEqual(config, {
      allowedTools: ["codex", "claude-code", "hermes"],
      defaultTool: "hermes",
    });

    const savedConfig = JSON.parse(
      await readFile(configPath(context.homeDir), "utf8"),
    ) as AgenticsConfig;
    assert.equal(savedConfig.defaultTool, "hermes");
  });

  test("clones configured content library and reads name-keyed catalog entries", async () => {
    const context = await setup();
    const remoteDir = await createContentLibraryRemote(context, {
      "demo-skill": {
        type: "skill",
        description: "Demo skill",
        path: "skills/demo-skill",
        upstream: "https://example.com/demo-skill",
      },
    });

    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        contentLibrary: remoteDir,
        allowedTools: ["codex", "claude-code", "hermes"],
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runAgentics(context, ["add", "demo-skill"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /demo-skill/);
    assert.match(result.stdout, /skill/);
    assert.match(result.stdout, /Demo skill/);
    assert.match(result.stdout, /https:\/\/example\.com\/demo-skill/);

    const reusedClone = await runAgentics(context, ["add", "demo-skill"]);
    assert.equal(reusedClone.exitCode, 0, reusedClone.stderr);

    const cloneHead = await git(join(context.homeDir, "content-library"), [
      "rev-parse",
      "HEAD",
    ]);
    assert.match(cloneHead.stdout.trim(), /^[a-f0-9]{40}$/);
  });

  test("fails with a clear error when the catalog is invalid", async () => {
    const context = await setup();
    const remoteDir = await createContentLibraryRemote(context, {
      broken: {
        type: "skill",
        description: "Broken skill",
      },
    });

    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        contentLibrary: remoteDir,
        allowedTools: ["codex"],
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runAgentics(context, ["add", "broken"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid catalog/);
    assert.match(result.stderr, /path/);
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

interface TestCatalogEntry {
  type?: string;
  description?: string;
  path?: string;
  upstream?: string;
}

async function createContentLibraryRemote(
  context: CliTestContext,
  catalog: Record<string, TestCatalogEntry>,
): Promise<string> {
  const repoDir = join(context.rootDir, "content-library-source");
  const remoteDir = join(context.rootDir, "content-library.git");

  await createGitRepository(repoDir);
  await mkdir(join(repoDir, "skills", "demo-skill"), { recursive: true });
  await writeFile(join(repoDir, "skills", "demo-skill", "SKILL.md"), "# Demo\n");
  await writeFile(join(repoDir, "index.json"), `${JSON.stringify(catalog)}\n`);
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "add catalog"]);
  await createBareRemote(remoteDir);
  await git(repoDir, ["remote", "add", "origin", remoteDir]);
  await git(repoDir, ["push", "-u", "origin", "HEAD"]);

  return remoteDir;
}
