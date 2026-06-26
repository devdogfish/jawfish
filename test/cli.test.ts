import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import {
  createBareRemote,
  createCliTestContext,
  createGitRepository,
  git,
  runJawfish,
  type CliTestContext,
} from "./helpers/cli.ts";
import {
  configPath,
  defaultSupportedTools,
  loadConfig,
  type JawfishConfig,
} from "../src/config.ts";
import { normalizeSourceUrl } from "../src/main.ts";

const contexts: CliTestContext[] = [];

async function setup(): Promise<CliTestContext> {
  const context = await createCliTestContext();
  contexts.push(context);
  return context;
}

async function writeJawfishConfig(
  context: CliTestContext,
  libraryDir: string,
  tool = "codex",
): Promise<void> {
  const configDir = join(context.homeDir, ".config", "jawfish");

  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        contentLibrary: libraryDir,
        defaultTool: tool,
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

interface UpstreamFocusLibrary {
  libraryDir: string;
  remoteDir: string;
  upstreamDir: string;
}

interface BulkUpdateLibrary extends UpstreamFocusLibrary {
  upstreamPlanDir: string;
}

async function setupUpstreamFocusLibrary(
  context: CliTestContext,
  options: {
    catalogFile?: "catalog.json" | "index.json";
    pushRemote?: boolean;
    staleFile?: boolean;
    upstream?: string;
  } = {},
): Promise<UpstreamFocusLibrary> {
  const libraryDir = join(context.rootDir, "content-library");
  const remoteDir = join(context.rootDir, "content-library.git");
  const upstreamDir = join(context.rootDir, "upstream-focus");
  const catalogFile = options.catalogFile ?? "index.json";
  const shouldPushRemote = options.pushRemote ?? true;
  const focusEntry = {
    description: "Focus workflow",
    path: "skills/focus",
    type: "skill",
    upstream: options.upstream ?? upstreamDir,
  };
  const catalog =
    catalogFile === "catalog.json"
      ? { jawfish: { focus: focusEntry } }
      : { focus: focusEntry };

  await createGitRepository(libraryDir);
  if (shouldPushRemote) {
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
  }

  await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
  await writeFile(
    join(libraryDir, catalogFile),
    JSON.stringify(catalog, null, 2),
  );
  await writeFile(join(libraryDir, "skills", "focus", "SKILL.md"), "# Old\n");
  if (options.staleFile) {
    await writeFile(join(libraryDir, "skills", "focus", "stale.md"), "stale\n");
  }

  await git(libraryDir, ["add", "."]);
  await git(libraryDir, ["commit", "-m", "seed focus"]);
  if (shouldPushRemote) {
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
  }

  await mkdir(upstreamDir, { recursive: true });
  await writeFile(join(upstreamDir, "SKILL.md"), "# New\n");

  return { libraryDir, remoteDir, upstreamDir };
}

async function setupBulkUpdateLibrary(
  context: CliTestContext,
  options: {
    includeSkipped?: boolean;
    pushRemote?: boolean;
  } = {},
): Promise<BulkUpdateLibrary> {
  const { libraryDir, remoteDir, upstreamDir } =
    await setupUpstreamFocusLibrary(context, {
      pushRemote: options.pushRemote,
    });
  const upstreamPlanDir = join(context.rootDir, "upstream-plan");
  const catalog: Record<string, unknown> = {
    focus: {
      description: "Focus workflow",
      path: "skills/focus",
      type: "skill",
      upstream: upstreamDir,
    },
    plan: {
      description: "Plan prompt",
      path: "prompts/plan",
      type: "prompt",
      upstream: upstreamPlanDir,
    },
  };

  if (options.includeSkipped) {
    catalog.scratch = {
      description: "Scratch prompt",
      path: "prompts/scratch",
      type: "prompt",
    };
  }

  await mkdir(join(libraryDir, "prompts", "plan"), { recursive: true });
  await writeFile(join(libraryDir, "prompts", "plan", "plan.md"), "Old plan\n");
  if (options.includeSkipped) {
    await mkdir(join(libraryDir, "prompts", "scratch"), { recursive: true });
    await writeFile(
      join(libraryDir, "prompts", "scratch", "scratch.md"),
      "Draft\n",
    );
  }
  await mkdir(upstreamPlanDir, { recursive: true });
  await writeFile(join(upstreamPlanDir, "plan.md"), "New plan\n");
  await writeFile(
    join(libraryDir, "index.json"),
    JSON.stringify(catalog, null, 2),
  );
  await git(libraryDir, ["add", "."]);
  await git(libraryDir, ["commit", "-m", "add bulk fixtures"]);
  if (options.pushRemote ?? true) {
    await git(libraryDir, ["push"]);
  }

  return { libraryDir, remoteDir, upstreamDir, upstreamPlanDir };
}

function installedFocusSkillPath(
  context: CliTestContext,
  tool: string,
  scope: "project" | "global",
  codexHome: string,
): string {
  return join(
    toolRoot(context, tool, scope, codexHome),
    "skills",
    "focus",
    "SKILL.md",
  );
}

function toolRoot(
  context: CliTestContext,
  tool: string,
  scope: "project" | "global",
  codexHome: string,
): string {
  switch (tool) {
    case "codex":
      return scope === "project"
        ? join(context.projectDir, ".codex")
        : codexHome;
    case "claude-code":
      return join(scopeRoot(context, scope), ".claude");
    case "hermes":
      return join(scopeRoot(context, scope), ".hermes");
    case "openclaw":
      return scope === "project"
        ? context.projectDir
        : join(context.homeDir, ".openclaw");
    case "opencode":
      return scope === "project"
        ? join(context.projectDir, ".opencode")
        : join(context.homeDir, ".config", "opencode");
    case "pi":
      return scope === "project"
        ? join(context.projectDir, ".pi")
        : join(context.homeDir, ".pi", "agent");
    default:
      throw new Error(`Unsupported test tool: ${tool}`);
  }
}

function scopeRoot(
  context: CliTestContext,
  scope: "project" | "global",
): string {
  return scope === "project" ? context.projectDir : context.homeDir;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe("jawfish CLI", () => {
  test("adds a catalog skill to the current project for the default tool", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(libraryDir, "catalog.json"),
      JSON.stringify(
        {
          jawfish: {
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
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["add", "focus"]);

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
      JSON.parse(
        await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      ),
      {
        jawfish: {
          focus: {
            tool: "codex",
          },
        },
      },
    );
  });

  test("install and i with a target add the agentic", async () => {
    for (const command of ["install", "i"]) {
      const context = await setup();
      const libraryDir = join(context.rootDir, "content-library");

      await createGitRepository(libraryDir);
      await writeIndexedFocusSkill(libraryDir);
      await writeJawfishConfig(context, libraryDir);

      const result = await runJawfish(context, [command, "focus"]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(
        await readFile(
          join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
          "utf8",
        ),
        "# Focus\n\nUse focused execution.\n",
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
        ),
        { jawfish: { focus: { tool: "codex" } } },
      );
    }
  });

  test("i without a target installs the manifest", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );

    const result = await runJawfish(context, ["i"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n\nUse focused execution.\n",
    );
  });

  test("adds a name-keyed catalog skill to project and global directories for each tool", async () => {
    for (const tool of [
      "codex",
      "claude-code",
      "hermes",
      "openclaw",
      "opencode",
      "pi",
    ] as const) {
      const context = await setup();
      const libraryDir = join(context.rootDir, "content-library");
      const codexHome = join(context.rootDir, "codex-home");
      const env: Record<string, string> =
        tool === "codex" ? { CODEX_HOME: codexHome } : {};
      const projectSkill = installedFocusSkillPath(
        context,
        tool,
        "project",
        codexHome,
      );
      const globalSkill = installedFocusSkillPath(
        context,
        tool,
        "global",
        codexHome,
      );

      await createGitRepository(libraryDir);
      await writeIndexedFocusSkill(libraryDir);
      await writeJawfishConfig(context, libraryDir, tool);

      const projectResult = await runJawfish(context, ["add", "focus"], {
        env,
      });
      const globalResult = await runJawfish(context, ["add", "-g", "focus"], {
        env,
      });

      assert.equal(projectResult.exitCode, 0, projectResult.stderr);
      assert.equal(globalResult.exitCode, 0, globalResult.stderr);
      assert.equal(
        await readFile(projectSkill, "utf8"),
        "# Focus\n\nUse focused execution.\n",
      );
      assert.equal(
        await readFile(globalSkill, "utf8"),
        "# Focus\n\nUse focused execution.\n",
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
        ),
        { jawfish: { focus: { tool } } },
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(context.homeDir, "jawfish.json"), "utf8"),
        ),
        { jawfish: { focus: { tool } } },
      );
    }
  });

  test("imports global skills from a supported tool with yes", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const codexHome = join(context.rootDir, "codex-home");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await writeJawfishConfig(context, libraryDir);
    await mkdir(join(codexHome, "skills", "focus"), { recursive: true });
    await writeFile(
      join(codexHome, "skills", "focus", "SKILL.md"),
      "# Focus\n",
    );

    const result = await runJawfish(
      context,
      ["import-skills", "codex", "--yes"],
      { env: { CODEX_HOME: codexHome } },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /import: focus/);
    assert.match(result.stdout, /Imported 1 skills from codex/);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Focus\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(libraryDir, "index.json"), "utf8")),
      {
        focus: {
          description: "",
          path: "skills/focus",
          type: "skill",
        },
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(context.homeDir, "jawfish.json"), "utf8")),
      { jawfish: { focus: { tool: "codex" } } },
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(codexHome, "skills", "focus", ".jawfish-managed.json"),
          "utf8",
        ),
      ),
      {
        files: ["SKILL.md"],
        name: "focus",
        tool: "codex",
        type: "skill",
      },
    );
  });

  test("skips import conflicts", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const codexHome = join(context.rootDir, "codex-home");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await writeIndexedFocusSkill(libraryDir);
    await git(libraryDir, ["add", "."]);
    await git(libraryDir, ["commit", "-m", "add focus"]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await writeJawfishConfig(context, libraryDir);
    await mkdir(join(codexHome, "skills", "focus"), { recursive: true });
    await writeFile(
      join(codexHome, "skills", "focus", "SKILL.md"),
      "# Different focus\n",
    );

    const result = await runJawfish(
      context,
      ["import-skills", "codex", "--yes"],
      { env: { CODEX_HOME: codexHome } },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /import: none/);
    assert.match(result.stdout, /conflicts: focus/);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Focus\n\nUse focused execution.\n",
    );
  });

  test("accepts any supported default tool without allowlist config", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir, "hermes");

    const result = await runJawfish(context, ["add", "focus"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      ),
      { jawfish: { focus: { tool: "hermes" } } },
    );
  });

  test("fails when manifest tool is unsupported", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir, "codex");
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "unknown" } } }, null, 2),
    );

    const result = await runJawfish(context, ["install"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unsupported manifest entry "focus": unknown/);
    assert.match(
      result.stderr,
      /Supported tools: codex, claude-code, hermes, openclaw, opencode, pi/,
    );
  });

  test("fails with a clear error for unsupported config defaultTool", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir, "unknown");

    const result = await runJawfish(context, ["add", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unsupported config defaultTool: unknown/);
    assert.match(
      result.stderr,
      /Supported tools: codex, claude-code, hermes, openclaw, opencode, pi/,
    );
  });

  test("installs native prompt files for opencode and pi", async () => {
    for (const tool of ["opencode", "pi"] as const) {
      const context = await setup();
      const libraryDir = join(context.rootDir, "content-library");
      const nativePromptPath =
        tool === "opencode"
          ? join(context.projectDir, ".opencode", "commands", "review.md")
          : join(context.projectDir, ".pi", "prompts", "review.md");

      await createGitRepository(libraryDir);
      await mkdir(join(libraryDir, "prompts", "review"), {
        recursive: true,
      });
      await writeFile(
        join(libraryDir, "index.json"),
        JSON.stringify(
          {
            review: {
              description: "Review prompt",
              path: "prompts/review",
              type: "prompt",
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(libraryDir, "prompts", "review", "review.md"),
        "# Review\n",
      );
      await writeJawfishConfig(context, libraryDir, tool);

      const result = await runJawfish(context, ["add", "review"]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(await readFile(nativePromptPath, "utf8"), "# Review\n");
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(
              dirname(nativePromptPath),
              ".jawfish-managed",
              "review.md.json",
            ),
            "utf8",
          ),
        ),
        {
          files: ["review.md"],
          name: "review",
          tool,
          type: "prompt",
        },
      );

      const removeResult = await runJawfish(context, ["remove", "review"]);

      assert.equal(removeResult.exitCode, 0, removeResult.stderr);
      await assert.rejects(readFile(nativePromptPath, "utf8"), /ENOENT/);
      await assert.rejects(
        readFile(
          join(
            dirname(nativePromptPath),
            ".jawfish-managed",
            "review.md.json",
          ),
          "utf8",
        ),
        /ENOENT/,
      );
    }
  });

  test("rejects non-skill packages for openclaw", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await mkdir(join(libraryDir, "prompts", "review"), {
      recursive: true,
    });
    await writeFile(
      join(libraryDir, "index.json"),
      JSON.stringify(
        {
          review: {
            description: "Review prompt",
            path: "prompts/review",
            type: "prompt",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(libraryDir, "prompts", "review", "review.md"),
      "# Review\n",
    );
    await writeJawfishConfig(context, libraryDir, "openclaw");

    const result = await runJawfish(context, ["add", "review"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /OpenClaw supports only skill packages/);
  });

  test("installs and removes project manifest jawfish", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await mkdir(join(libraryDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(libraryDir, "catalog.json"),
      JSON.stringify(
        {
          jawfish: {
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
      "# Focus\n",
    );
    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );

    const installResult = await runJawfish(context, ["install"]);

    assert.equal(installResult.exitCode, 0);
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n",
    );

    const removeResult = await runJawfish(context, ["remove", "focus"]);

    assert.equal(removeResult.exitCode, 0);
    await assert.rejects(
      readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      /ENOENT/,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      ),
      { jawfish: {} },
    );
  });

  test("reinstall overwrites managed files, removes stale managed files, and preserves unmanaged files", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeFile(join(libraryDir, "skills", "focus", "old.md"), "old\n");
    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );

    const firstInstall = await runJawfish(context, ["install"]);

    assert.equal(firstInstall.exitCode, 0, firstInstall.stderr);
    await writeFile(join(installDir, "user.md"), "manual\n");
    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# New Focus\n",
    );
    await rm(join(libraryDir, "skills", "focus", "old.md"));

    const reinstall = await runJawfish(context, ["install"]);

    assert.equal(reinstall.exitCode, 0, reinstall.stderr);
    assert.equal(
      await readFile(join(installDir, "SKILL.md"), "utf8"),
      "# New Focus\n",
    );
    await assert.rejects(
      readFile(join(installDir, "old.md"), "utf8"),
      /ENOENT/,
    );
    assert.equal(
      await readFile(join(installDir, "user.md"), "utf8"),
      "manual\n",
    );
  });

  test("install aborts when source files conflict with unmanaged destination files", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await runJawfish(context, ["install"]);
    await writeFile(join(installDir, "notes.md"), "manual\n");
    await writeFile(
      join(libraryDir, "skills", "focus", "notes.md"),
      "managed\n",
    );

    const result = await runJawfish(context, ["install"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unmanaged destination file/);
    assert.match(result.stderr, /Remove it or move it aside/);
    assert.equal(
      await readFile(join(installDir, "notes.md"), "utf8"),
      "manual\n",
    );
  });

  test("remove deletes managed files and manifest entries while preserving unmanaged files", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await runJawfish(context, ["install"]);
    await writeFile(join(installDir, "user.md"), "manual\n");

    const result = await runJawfish(context, ["remove", "focus"]);

    assert.equal(result.exitCode, 0, result.stderr);
    await assert.rejects(
      readFile(join(installDir, "SKILL.md"), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(join(installDir, ".jawfish-managed.json"), "utf8"),
      /ENOENT/,
    );
    assert.equal(
      await readFile(join(installDir, "user.md"), "utf8"),
      "manual\n",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      ),
      { jawfish: {} },
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
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, [
      "add",
      join(sourceDir, "brief.md"),
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(
      await readFile(
        join(
          context.projectDir,
          ".codex",
          "prompts",
          "daily-brief",
          "notes.txt",
        ),
        "utf8",
      ),
      "Keep it concise.\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(libraryDir, "index.json"), "utf8")),
      {
        "daily-brief": {
          description: "",
          path: "prompts/daily-brief",
          type: "prompt",
          upstream: join(sourceDir, "brief.md"),
        },
      },
    );

    const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
  });

  test("imports into a local git library without a push destination", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const sourceDir = join(context.rootDir, "focus");

    await createGitRepository(libraryDir);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Focus\n");
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["add", sourceDir]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      ),
      { jawfish: { focus: { tool: "codex" } } },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(libraryDir, "index.json"), "utf8")),
      {
        focus: {
          description: "",
          path: "skills/focus",
          type: "skill",
          upstream: sourceDir,
        },
      },
    );
  });

  test("imports a URL file parent package, pushes the library, and installs it", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const sourceDir = join(context.rootDir, "upstream-focus");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Focus\n");
    await writeFile(
      join(sourceDir, "references.md"),
      "Use deep work blocks.\n",
    );
    await writeJawfishConfig(context, libraryDir);

    const server = await serveStaticDirectory(context.rootDir);
    const sourceUrl = `${server.url}/upstream-focus/SKILL.md`;
    try {
      const result = await runJawfish(context, ["add", sourceUrl]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(
        await readFile(
          join(
            context.projectDir,
            ".codex",
            "skills",
            "upstream-focus",
            "references.md",
          ),
          "utf8",
        ),
        "Use deep work blocks.\n",
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(libraryDir, "index.json"), "utf8")),
        {
          "upstream-focus": {
            description: "",
            path: "skills/upstream-focus",
            type: "skill",
            upstream: sourceUrl,
          },
        },
      );

      const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
      const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
      assert.equal(localHead.stdout, remoteHead.stdout);
    } finally {
      await server.close();
    }
  });

  test("imports a URL file when the parent URL cannot be listed", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await writeJawfishConfig(context, libraryDir);

    const server = createServer((request, response) => {
      if (request.url === "/upstream-focus/SKILL.md") {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end("# Focus\n");
        return;
      }

      response.writeHead(400, { "content-type": "text/plain" });
      response.end("directory listing unavailable\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }
    const sourceUrl = `http://127.0.0.1:${address.port}/upstream-focus/SKILL.md`;

    try {
      const result = await runJawfish(context, ["add", sourceUrl]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(
        await readFile(
          join(
            context.projectDir,
            ".codex",
            "skills",
            "upstream-focus",
            "SKILL.md",
          ),
          "utf8",
        ),
        "# Focus\n",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  test("normalizes GitHub blob file URLs to raw URLs", () => {
    assert.equal(
      normalizeSourceUrl(
        "https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md",
      ),
      "https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md",
    );
  });

  test("imports a URL directory package with agent type inference", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const sourceDir = join(context.rootDir, "review-agent");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "AGENT.md"), "# Review Agent\n");
    await writeFile(join(sourceDir, "checklist.md"), "Check tests.\n");
    await writeJawfishConfig(context, libraryDir);

    const server = await serveStaticDirectory(context.rootDir);
    const sourceUrl = `${server.url}/review-agent`;
    try {
      const result = await runJawfish(context, ["add", sourceUrl]);

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(
        await readFile(
          join(
            context.projectDir,
            ".codex",
            "agents",
            "review-agent",
            "checklist.md",
          ),
          "utf8",
        ),
        "Check tests.\n",
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(libraryDir, "index.json"), "utf8")),
        {
          "review-agent": {
            description: "",
            path: "agents/review-agent",
            type: "agent",
            upstream: sourceUrl,
          },
        },
      );
    } finally {
      await server.close();
    }
  });

  test("installs an already imported URL source into another scope", async () => {
    const context = await setup();
    const sourceDir = join(context.rootDir, "repeat-skill");

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Repeat\n");

    const server = await serveStaticDirectory(context.rootDir);
    const sourceUrl = `${server.url}/repeat-skill`;
    try {
      const projectResult = await runJawfish(context, ["add", sourceUrl], {
        env: { JAWFISH_DEFAULT_TOOL: "codex" },
      });
      assert.equal(projectResult.exitCode, 0, projectResult.stderr);

      const globalResult = await runJawfish(context, ["add", "-g", sourceUrl], {
        env: { JAWFISH_DEFAULT_TOOL: "codex" },
      });

      assert.equal(globalResult.exitCode, 0, globalResult.stderr);
      assert.match(globalResult.stdout, /Added repeat-skill to global/);
      assert.equal(
        await readFile(
          join(context.homeDir, ".codex", "skills", "repeat-skill", "SKILL.md"),
          "utf8",
        ),
        "# Repeat\n",
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(context.homeDir, "jawfish.json"), "utf8")),
        {
          jawfish: {
            "repeat-skill": {
              tool: "codex",
            },
          },
        },
      );
    } finally {
      await server.close();
    }
  });

  test("imports an ambiguous local package with selected type and name override", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");
    const remoteDir = join(context.rootDir, "content-library.git");
    const sourceDir = join(context.rootDir, "scratch-agent");

    await createGitRepository(libraryDir);
    await createBareRemote(remoteDir);
    await git(libraryDir, ["remote", "add", "origin", remoteDir]);
    await git(libraryDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "README.md"), "# Scratch\n");
    await writeFile(join(sourceDir, "notes.txt"), "Act carefully.\n");
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(
      context,
      ["add", "--name", "careful-agent", sourceDir],
      { env: { JAWFISH_IMPORT_TYPE: "agent" } },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(
        join(
          context.projectDir,
          ".codex",
          "agents",
          "careful-agent",
          "notes.txt",
        ),
        "utf8",
      ),
      "Act carefully.\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(libraryDir, "index.json"), "utf8")),
      {
        "careful-agent": {
          description: "",
          path: "agents/careful-agent",
          type: "agent",
          upstream: sourceDir,
        },
      },
    );
  });

  test("updates an upstream package, removes stale files, pushes, and reinstalls", async () => {
    const context = await setup();
    const { libraryDir, remoteDir } = await setupUpstreamFocusLibrary(context, {
      catalogFile: "catalog.json",
      staleFile: true,
    });
    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await runJawfish(context, ["install"]);

    const result = await runJawfish(context, ["update", "focus"]);

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

  test("fails to update a package without upstream metadata", async () => {
    const context = await setup();
    const libraryDir = join(context.rootDir, "content-library");

    await createGitRepository(libraryDir);
    await writeIndexedFocusSkill(libraryDir);
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Agentic has no upstream: focus/);
  });

  test("updates from a file upstream by replacing with the parent directory", async () => {
    const context = await setup();
    const upstreamDir = join(context.rootDir, "upstream-focus");
    const { libraryDir } = await setupUpstreamFocusLibrary(context, {
      staleFile: true,
      upstream: join(upstreamDir, "SKILL.md"),
    });
    await writeFile(
      join(upstreamDir, "references.md"),
      "Use deep work blocks.\n",
    );
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(
        join(libraryDir, "skills", "focus", "references.md"),
        "utf8",
      ),
      "Use deep work blocks.\n",
    );
    await assert.rejects(
      readFile(join(libraryDir, "skills", "focus", "stale.md"), "utf8"),
      /ENOENT/,
    );
  });

  test("aborts update when the local package has dirty changes", async () => {
    const context = await setup();
    const { libraryDir } = await setupUpstreamFocusLibrary(context, {
      pushRemote: false,
    });
    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Package has dirty local changes: focus/);
    assert.match(result.stderr, /skills\/focus\/SKILL\.md/);
    assert.match(result.stderr, /jawfish update --force focus/);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Dirty\n",
    );
  });

  test("force flags update a package with dirty local changes", async () => {
    const context = await setup();
    const { libraryDir, upstreamDir } =
      await setupUpstreamFocusLibrary(context);
    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update", "-F", "focus"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );

    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# Dirty again\n",
    );
    await writeFile(join(upstreamDir, "SKILL.md"), "# Newer\n");

    const longFlagResult = await runJawfish(context, [
      "update",
      "--force",
      "focus",
    ]);

    assert.equal(longFlagResult.exitCode, 0, longFlagResult.stderr);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Newer\n",
    );
  });

  test("push failure leaves the update commit intact with recovery guidance", async () => {
    const context = await setup();
    const { libraryDir, remoteDir } = await setupUpstreamFocusLibrary(context);
    await writeFile(
      join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\necho rejected by test >&2\nexit 1\n",
    );
    await chmod(join(remoteDir, "hooks", "pre-receive"), 0o755);
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Library commit was created, but push failed/);
    assert.match(result.stderr, /rejected by test/);
    assert.match(result.stderr, /git -C .* push/);

    const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const commitMessage = await git(libraryDir, ["log", "-1", "--pretty=%s"]);
    assert.notEqual(localHead.stdout, remoteHead.stdout);
    assert.equal(commitMessage.stdout.trim(), "update focus");
  });

  test("update reinstalls only in the selected scope when already installed", async () => {
    const context = await setup();
    const { libraryDir } = await setupUpstreamFocusLibrary(context);
    const codexHome = join(context.rootDir, "codex-home");
    const env = { CODEX_HOME: codexHome };

    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await writeFile(
      join(context.homeDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    const projectInstall = await runJawfish(context, ["install"], { env });
    const globalInstall = await runJawfish(context, ["install", "-g"], { env });

    assert.equal(projectInstall.exitCode, 0, projectInstall.stderr);
    assert.equal(globalInstall.exitCode, 0, globalInstall.stderr);

    const result = await runJawfish(context, ["update", "-g", "focus"], {
      env,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(join(codexHome, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Old\n",
    );
  });

  test("bulk update reports updated and skipped packages", async () => {
    const context = await setup();
    const { libraryDir } = await setupBulkUpdateLibrary(context, {
      includeSkipped: true,
    });
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stdout, /Skipped: scratch/);
    assert.match(result.stdout, /Failed: none/);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );
    assert.equal(
      await readFile(join(libraryDir, "prompts", "plan", "plan.md"), "utf8"),
      "New plan\n",
    );
  });

  test("bulk update commits and pushes all upstream packages", async () => {
    const context = await setup();
    const { libraryDir, remoteDir } = await setupBulkUpdateLibrary(context);
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stdout, /Skipped: none/);
    const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const commitMessage = await git(libraryDir, ["log", "-1", "--pretty=%s"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
    assert.equal(commitMessage.stdout.trim(), "update jawfish");
  });

  test("bulk update reports dirty packages as failed without committing", async () => {
    const context = await setup();
    const { libraryDir } = await setupBulkUpdateLibrary(context);
    const initialHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Updated: plan/);
    assert.match(
      result.stdout,
      /Failed: focus \(Package has dirty local changes: focus\)/,
    );
    assert.match(result.stderr, /skills\/focus\/SKILL\.md/);
    assert.match(result.stderr, /jawfish update --force focus/);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Dirty\n",
    );
    const finalHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    assert.equal(finalHead.stdout, initialHead.stdout);
  });

  test("force bulk update replaces dirty packages", async () => {
    const context = await setup();
    const { libraryDir } = await setupBulkUpdateLibrary(context);
    await writeFile(
      join(libraryDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update", "-F"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stdout, /Failed: none/);
    assert.equal(
      await readFile(join(libraryDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );
  });

  test("bulk update reinstalls updated packages only in the selected scope", async () => {
    const context = await setup();
    const { libraryDir } = await setupBulkUpdateLibrary(context);
    const codexHome = join(context.rootDir, "codex-home");
    const env = { CODEX_HOME: codexHome };

    await writeJawfishConfig(context, libraryDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await writeFile(
      join(context.homeDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    assert.equal((await runJawfish(context, ["install"], { env })).exitCode, 0);
    assert.equal(
      (await runJawfish(context, ["install", "-g"], { env })).exitCode,
      0,
    );

    const result = await runJawfish(context, ["update", "-g"], { env });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(join(codexHome, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Old\n",
    );
  });

  test("bulk push failure leaves the commit intact with recovery guidance", async () => {
    const context = await setup();
    const { libraryDir, remoteDir } = await setupBulkUpdateLibrary(context);
    await writeFile(
      join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\necho rejected by test >&2\nexit 1\n",
    );
    await chmod(join(remoteDir, "hooks", "pre-receive"), 0o755);
    await writeJawfishConfig(context, libraryDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stderr, /Library commit was created, but push failed/);
    assert.match(result.stderr, /git -C .* push/);
    const localHead = await git(libraryDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const commitMessage = await git(libraryDir, ["log", "-1", "--pretty=%s"]);
    assert.notEqual(localHead.stdout, remoteHead.stdout);
    assert.equal(commitMessage.stdout.trim(), "update jawfish");
  });

  test("prints root help and command help for the initial surface", async () => {
    const context = await setup();

    const rootHelp = await runJawfish(context, ["--help"]);
    assert.equal(rootHelp.exitCode, 0);
    assert.match(rootHelp.stdout, /Usage: jawfish <command>/);
    assert.match(rootHelp.stdout, /-v, --version\s+Show version/);

    for (const command of [
      "add",
      "init",
      "import-skills",
      "install",
      "i",
      "update",
      "upgrade",
      "remove",
    ]) {
      const result = await runJawfish(context, [command, "--help"]);

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`Usage: jawfish ${command}`));
    }
  });

  test("adds a URL source with no configured content library", async () => {
    const context = await setup();
    const sourceDir = join(context.rootDir, "quick-skill");

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Quick\n");

    const server = await serveStaticDirectory(context.rootDir);
    try {
      const result = await runJawfish(
        context,
        ["add", `${server.url}/quick-skill`],
        {
          env: { JAWFISH_DEFAULT_TOOL: "codex" },
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Added quick-skill to project/);
      assert.equal(
        await readFile(
          join(
            context.projectDir,
            ".codex",
            "skills",
            "quick-skill",
            "SKILL.md",
          ),
          "utf8",
        ),
        "# Quick\n",
      );
      assert.deepEqual(
        JSON.parse(await readFile(configPath(context.homeDir), "utf8")),
        {
          contentLibrary: join(context.homeDir, "content-library"),
          defaultTool: "codex",
        },
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(context.homeDir, "content-library", "index.json"),
            "utf8",
          ),
        ),
        {
          "quick-skill": {
            description: "",
            path: "skills/quick-skill",
            type: "skill",
            upstream: `${server.url}/quick-skill`,
          },
        },
      );
    } finally {
      await server.close();
    }
  });

  test("initializes config and a local content library", async () => {
    const context = await setup();

    const result = await runJawfish(context, ["init"], {
      env: { JAWFISH_DEFAULT_TOOL: "codex" },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Initialized jawfish/);
    assert.deepEqual(
      JSON.parse(await readFile(configPath(context.homeDir), "utf8")),
      {
        contentLibrary: join(context.homeDir, "content-library"),
        defaultTool: "codex",
      },
    );
    await stat(join(context.homeDir, "content-library", ".git"));
  });

  test("prints a clear error for an unknown catalog name in an empty local library", async () => {
    const context = await setup();

    const result = await runJawfish(context, ["add", "missing"], {
      env: { JAWFISH_DEFAULT_TOOL: "codex" },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unknown agentic: missing/);
  });

  test("prints version with long and short flags", async () => {
    const context = await setup();

    for (const flag of ["--version", "-v"]) {
      const result = await runJawfish(context, [flag]);

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
      assert.equal(result.stderr, "");
    }
  });

  test("upgrade updates jawfish through bun", async () => {
    const context = await setup();
    const fakeBinDir = join(context.rootDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const logPath = join(context.rootDir, "bun-args.txt");

    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(logPath)}\necho upgraded\n`,
    );
    await chmod(fakeBun, 0o755);

    const result = await runJawfish(context, ["upgrade"], {
      env: { PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Upgrading jawfish with bun/);
    assert.match(result.stdout, /upgraded/);
    assert.equal(
      await readFile(logPath, "utf8"),
      "update\n-g\njawfish\n--latest\n",
    );
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

    const result = await runJawfish(context, ["add", "demo-skill"], {
      env: {
        JAWFISH_CONTENT_LIBRARY: remoteDir,
        JAWFISH_DEFAULT_TOOL: "claude-code",
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const config = JSON.parse(
      await readFile(configPath(context.homeDir), "utf8"),
    );

    assert.deepEqual(config, {
      contentLibrary: remoteDir,
      defaultTool: "claude-code",
    });
  });

  test("prompts for a missing default tool and saves the selected tool", async () => {
    const context = await setup();
    let promptedTools: readonly string[] = [];

    const config = await loadConfig({
      env: {
        JAWFISH_HOME: context.homeDir,
      },
      promptForDefaultTool: async (supportedTools) => {
        promptedTools = supportedTools;
        return "hermes";
      },
    });

    assert.deepEqual(promptedTools, [...defaultSupportedTools]);
    assert.deepEqual(config, {
      defaultTool: "hermes",
    });

    const savedConfig = JSON.parse(
      await readFile(configPath(context.homeDir), "utf8"),
    ) as JawfishConfig;
    assert.equal(savedConfig.defaultTool, "hermes");
  });

  test("rejects unsupported JAWFISH_DEFAULT_TOOL", async () => {
    const context = await setup();
    const remoteDir = await createContentLibraryRemote(context, {
      "demo-skill": {
        type: "skill",
        description: "Demo skill",
        path: "skills/demo-skill",
      },
    });

    const result = await runJawfish(context, ["add", "demo-skill"], {
      env: {
        JAWFISH_CONTENT_LIBRARY: remoteDir,
        JAWFISH_DEFAULT_TOOL: "unknown",
      },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unsupported JAWFISH_DEFAULT_TOOL: unknown/);
    assert.match(
      result.stderr,
      /Supported tools: codex, claude-code, hermes, openclaw, opencode, pi/,
    );
  });

  test("rejects unsupported selected default tool", async () => {
    const context = await setup();

    await assert.rejects(
      loadConfig({
        env: {
          JAWFISH_HOME: context.homeDir,
        },
        promptForDefaultTool: async () => "unknown",
      }),
      /Unsupported selected default tool: unknown/,
    );
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
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["add", "demo-skill"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /demo-skill/);
    assert.match(result.stdout, /skill/);
    assert.match(result.stdout, /Demo skill/);
    assert.match(result.stdout, /https:\/\/example\.com\/demo-skill/);

    const reusedClone = await runJawfish(context, ["add", "demo-skill"]);
    assert.equal(reusedClone.exitCode, 0, reusedClone.stderr);

    const cloneDir = join(context.homeDir, "content-library");
    const cloneHead = await git(cloneDir, ["rev-parse", "HEAD"]);
    assert.match(cloneHead.stdout.trim(), /^[a-f0-9]{40}$/);
    assert.match(
      await readFile(join(cloneDir, ".gitignore"), "utf8"),
      /config\.json/,
    );
    assert.match(
      await readFile(join(cloneDir, ".gitignore"), "utf8"),
      /jawfish\.json/,
    );
  });

  test("rejects the old nested managed library path", async () => {
    const context = await setup();
    const oldLibraryDir = join(context.homeDir, "library");
    await createGitRepository(oldLibraryDir);
    await writeIndexedFocusSkill(oldLibraryDir);
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        contentLibrary: oldLibraryDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["add", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /Nested content library is no longer supported/,
    );
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
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["add", "broken"]);

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

    const result = await runJawfish(context, ["--version"]);

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

    const bareState = await git(remoteDir, [
      "rev-parse",
      "--is-bare-repository",
    ]);
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
  await writeFile(
    join(repoDir, "skills", "demo-skill", "SKILL.md"),
    "# Demo\n",
  );
  await writeFile(join(repoDir, "index.json"), `${JSON.stringify(catalog)}\n`);
  await git(repoDir, ["add", "."]);
  await git(repoDir, ["commit", "-m", "add catalog"]);
  await createBareRemote(remoteDir);
  await git(repoDir, ["remote", "add", "origin", remoteDir]);
  await git(repoDir, ["push", "-u", "origin", "HEAD"]);

  return remoteDir;
}

async function serveStaticDirectory(
  rootDir: string,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://x").pathname,
      );
      const requestedPath = resolve(rootDir, `.${pathname}`);
      const requestedRelative = relative(rootDir, requestedPath);

      if (requestedRelative.startsWith("..")) {
        response.writeHead(403).end();
        return;
      }

      const requestedStat = await stat(requestedPath);
      if (requestedStat.isDirectory()) {
        const entries = await readdir(requestedPath);
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          entries
            .map(
              (entry) => `<a href="${encodeURIComponent(entry)}">${entry}</a>`,
            )
            .join("\n"),
        );
        return;
      }

      response.writeHead(200, { "content-type": "text/plain" });
      response.end(await readFile(requestedPath));
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  return {
    close: () => closeServer(server),
    url: `http://127.0.0.1:${address.port}`,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolveClose();
    });
  });
}
