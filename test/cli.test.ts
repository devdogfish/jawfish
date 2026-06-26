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
import {
  initCommand,
  type InitCommandPrompts,
} from "../src/init-command.ts";
import { normalizeSourceUrl } from "../src/main.ts";

const contexts: CliTestContext[] = [];

async function setup(): Promise<CliTestContext> {
  const context = await createCliTestContext();
  contexts.push(context);
  return context;
}

async function writeJawfishConfig(
  context: CliTestContext,
  agenticsRepoDir: string,
  tool = "codex",
): Promise<void> {
  const configDir = join(context.homeDir, ".config", "jawfish");

  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        agenticsRepo: agenticsRepoDir,
        defaultTool: tool,
      },
      null,
      2,
    ),
  );
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertJsonFile(path: string, expected: unknown): Promise<void> {
  assert.deepEqual(await readJsonFile(path), expected);
}

async function assertMissingFile(path: string): Promise<void> {
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
}

function initArgs(overrides: Partial<Parameters<typeof initCommand>[0]> = {}) {
  return {
    force: false,
    global: false,
    positionals: [],
    raw: false,
    yes: false,
    ...overrides,
  };
}

async function captureConsole<T>(
  run: () => Promise<T>,
): Promise<{ result: T; stderr: string; stdout: string }> {
  const originalError = console.error;
  const originalLog = console.log;
  const stderr: string[] = [];
  const stdout: string[] = [];

  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  try {
    return {
      result: await run(),
      stderr: stderr.join("\n"),
      stdout: stdout.join("\n"),
    };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

async function assertCodexScopeConfigs(
  context: CliTestContext,
  name: string,
): Promise<void> {
  const expected = { jawfish: { [name]: { tool: "codex" } } };

  await assertJsonFile(join(context.projectDir, "jawfish.json"), expected);
  await assertJsonFile(join(context.homeDir, "jawfish.json"), expected);
}

async function writeIndexedFocusSkill(agenticsRepoDir: string): Promise<void> {
  await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
  await writeFile(
    join(agenticsRepoDir, "index.json"),
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
    join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
    "# Focus\n\nUse focused execution.\n",
  );
}

interface UpstreamFocusAgenticsRepo {
  agenticsRepoDir: string;
  remoteDir: string;
  upstreamDir: string;
}

interface BulkUpdateAgenticsRepo extends UpstreamFocusAgenticsRepo {
  upstreamPlanDir: string;
}

async function setupUpstreamFocusAgenticsRepo(
  context: CliTestContext,
  options: {
    catalogFile?: "catalog.json" | "index.json";
    pushRemote?: boolean;
    staleFile?: boolean;
    upstream?: string;
  } = {},
): Promise<UpstreamFocusAgenticsRepo> {
  const agenticsRepoDir = join(context.rootDir, "agentics");
  const remoteDir = join(context.rootDir, "agentics.git");
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

  await createGitRepository(agenticsRepoDir);
  if (shouldPushRemote) {
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
  }

  await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
  await writeFile(
    join(agenticsRepoDir, catalogFile),
    JSON.stringify(catalog, null, 2),
  );
  await writeFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "# Old\n");
  if (options.staleFile) {
    await writeFile(join(agenticsRepoDir, "skills", "focus", "stale.md"), "stale\n");
  }

  await git(agenticsRepoDir, ["add", "."]);
  await git(agenticsRepoDir, ["commit", "-m", "seed focus"]);
  if (shouldPushRemote) {
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
  }

  await mkdir(upstreamDir, { recursive: true });
  await writeFile(join(upstreamDir, "SKILL.md"), "# New\n");

  return { agenticsRepoDir, remoteDir, upstreamDir };
}

async function setupBulkUpdateAgenticsRepo(
  context: CliTestContext,
  options: {
    includeSkipped?: boolean;
    pushRemote?: boolean;
  } = {},
): Promise<BulkUpdateAgenticsRepo> {
  const { agenticsRepoDir, remoteDir, upstreamDir } =
    await setupUpstreamFocusAgenticsRepo(context, {
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

  await mkdir(join(agenticsRepoDir, "prompts", "plan"), { recursive: true });
  await writeFile(join(agenticsRepoDir, "prompts", "plan", "plan.md"), "Old plan\n");
  if (options.includeSkipped) {
    await mkdir(join(agenticsRepoDir, "prompts", "scratch"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "prompts", "scratch", "scratch.md"),
      "Draft\n",
    );
  }
  await mkdir(upstreamPlanDir, { recursive: true });
  await writeFile(join(upstreamPlanDir, "plan.md"), "New plan\n");
  await writeFile(
    join(agenticsRepoDir, "index.json"),
    JSON.stringify(catalog, null, 2),
  );
  await git(agenticsRepoDir, ["add", "."]);
  await git(agenticsRepoDir, ["commit", "-m", "add bulk fixtures"]);
  if (options.pushRemote ?? true) {
    await git(agenticsRepoDir, ["push"]);
  }

  return { agenticsRepoDir, remoteDir, upstreamDir, upstreamPlanDir };
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
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "catalog.json"),
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
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# Focus\n\nUse focused execution.\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

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
      const agenticsRepoDir = join(context.rootDir, "agentics");

      await createGitRepository(agenticsRepoDir);
      await writeIndexedFocusSkill(agenticsRepoDir);
      await writeJawfishConfig(context, agenticsRepoDir);

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
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
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
      const agenticsRepoDir = join(context.rootDir, "agentics");
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

      await createGitRepository(agenticsRepoDir);
      await writeIndexedFocusSkill(agenticsRepoDir);
      await writeJawfishConfig(context, agenticsRepoDir, tool);

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

  test("removing one scope preserves the other scope and unmanaged files", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const codexHome = join(context.rootDir, "codex-home");
    const env = { CODEX_HOME: codexHome };
    const projectSkill = join(
      context.projectDir,
      ".codex",
      "skills",
      "focus",
      "SKILL.md",
    );
    const globalSkill = join(codexHome, "skills", "focus", "SKILL.md");
    const globalNotes = join(codexHome, "skills", "focus", "notes.md");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    assert.equal(
      (await runJawfish(context, ["add", "focus"], { env })).exitCode,
      0,
    );
    assert.equal(
      (await runJawfish(context, ["add", "-g", "focus"], { env })).exitCode,
      0,
    );
    await writeFile(globalNotes, "manual\n");

    const result = await runJawfish(context, ["remove", "focus"], { env });

    assert.equal(result.exitCode, 0, result.stderr);
    await assert.rejects(readFile(projectSkill, "utf8"), /ENOENT/);
    assert.equal(
      await readFile(globalSkill, "utf8"),
      "# Focus\n\nUse focused execution.\n",
    );
    assert.equal(await readFile(globalNotes, "utf8"), "manual\n");
    assert.deepEqual(
      JSON.parse(
        await readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      ),
      { jawfish: {} },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(context.homeDir, "jawfish.json"), "utf8")),
      { jawfish: { focus: { tool: "codex" } } },
    );
  });

  test("imports global skills from a supported tool with yes", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");
    const codexHome = join(context.rootDir, "codex-home");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await writeJawfishConfig(context, agenticsRepoDir);
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
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Focus\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(agenticsRepoDir, "index.json"), "utf8")),
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

  test("imports global skills from every supported provider", async () => {
    for (const tool of defaultSupportedTools) {
      const context = await setup();
      const agenticsRepoDir = join(context.rootDir, `agentics-${tool}`);
      const codexHome = join(context.rootDir, "codex-home");
      const env: Record<string, string> =
        tool === "codex" ? { CODEX_HOME: codexHome } : {};
      const providerSkillDir = dirname(
        installedFocusSkillPath(context, tool, "global", codexHome),
      );

      await createGitRepository(agenticsRepoDir);
      await writeJawfishConfig(context, agenticsRepoDir);
      await mkdir(providerSkillDir, { recursive: true });
      await writeFile(join(providerSkillDir, "SKILL.md"), `# ${tool}\n`);

      const result = await runJawfish(
        context,
        ["import-skills", tool, "--yes"],
        { env },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /import: focus/);
      assert.deepEqual(
        JSON.parse(
          await readFile(join(context.homeDir, "jawfish.json"), "utf8"),
        ),
        { jawfish: { focus: { tool } } },
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(join(providerSkillDir, ".jawfish-managed.json"), "utf8"),
        ),
        {
          files: ["SKILL.md"],
          name: "focus",
          tool,
          type: "skill",
        },
      );
    }
  });

  test("strips provider managed markers from imported repo packages", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const codexHome = join(context.rootDir, "codex-home");
    const providerSkillDir = join(codexHome, "skills", "focus");

    await createGitRepository(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    await mkdir(providerSkillDir, { recursive: true });
    await writeFile(join(providerSkillDir, "SKILL.md"), "# Focus\n");
    await writeFile(
      join(providerSkillDir, ".jawfish-managed.json"),
      JSON.stringify(
        {
          files: ["SKILL.md", "old.md"],
          name: "focus",
          tool: "codex",
          type: "skill",
        },
        null,
        2,
      ),
    );

    const result = await runJawfish(
      context,
      ["import-skills", "codex", "--yes"],
      { env: { CODEX_HOME: codexHome } },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    await assert.rejects(
      readFile(
        join(agenticsRepoDir, "skills", "focus", ".jawfish-managed.json"),
        "utf8",
      ),
      { code: "ENOENT" },
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(providerSkillDir, ".jawfish-managed.json"),
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

  test("reports empty provider skill directories without writes", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const codexHome = join(context.rootDir, "codex-home");

    await createGitRepository(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    await mkdir(join(codexHome, "skills"), { recursive: true });

    const result = await runJawfish(
      context,
      ["import-skills", "codex", "--yes"],
      { env: { CODEX_HOME: codexHome } },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /No importable skills found/);
    await assert.rejects(readFile(join(agenticsRepoDir, "index.json"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(
      readFile(join(context.homeDir, "jawfish.json"), "utf8"),
      { code: "ENOENT" },
    );
  });

  test("fails unsupported provider imports with supported tools", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, [
      "import-skills",
      "unknown",
      "--yes",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unsupported provider: unknown/);
    assert.match(
      result.stderr,
      new RegExp(`Supported tools: ${defaultSupportedTools.join(", ")}`),
    );
  });

  test("skips import conflicts", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");
    const codexHome = join(context.rootDir, "codex-home");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await git(agenticsRepoDir, ["add", "."]);
    await git(agenticsRepoDir, ["commit", "-m", "add focus"]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await writeJawfishConfig(context, agenticsRepoDir);
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
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Focus\n\nUse focused execution.\n",
    );
  });

  test("accepts any supported default tool without allowlist config", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir, "hermes");

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
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir, "codex");
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

  test("install with a missing catalog entry aborts before writing managed files", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const installedSkill = join(
      context.projectDir,
      ".codex",
      "skills",
      "focus",
      "SKILL.md",
    );

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    const firstInstall = await runJawfish(context, ["install"]);
    assert.equal(firstInstall.exitCode, 0, firstInstall.stderr);
    await writeFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "# New\n");
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify(
        {
          jawfish: {
            focus: { tool: "codex" },
            missing: { tool: "codex" },
          },
        },
        null,
        2,
      ),
    );

    const result = await runJawfish(context, ["install"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Unknown agentic: missing/);
    assert.equal(
      await readFile(installedSkill, "utf8"),
      "# Focus\n\nUse focused execution.\n",
    );
  });

  test("fails with a clear error for unsupported config defaultTool", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir, "unknown");

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
      const agenticsRepoDir = join(context.rootDir, "agentics");
      const nativePromptPath =
        tool === "opencode"
          ? join(context.projectDir, ".opencode", "commands", "review.md")
          : join(context.projectDir, ".pi", "prompts", "review.md");

      await createGitRepository(agenticsRepoDir);
      await mkdir(join(agenticsRepoDir, "prompts", "review"), {
        recursive: true,
      });
      await writeFile(
        join(agenticsRepoDir, "index.json"),
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
        join(agenticsRepoDir, "prompts", "review", "review.md"),
        "# Review\n",
      );
      await writeJawfishConfig(context, agenticsRepoDir, tool);

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
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "prompts", "review"), {
      recursive: true,
    });
    await writeFile(
      join(agenticsRepoDir, "index.json"),
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
      join(agenticsRepoDir, "prompts", "review", "review.md"),
      "# Review\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir, "openclaw");

    const result = await runJawfish(context, ["add", "review"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /OpenClaw supports only skill packages/);
  });

  test("installs and removes project manifest jawfish", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "catalog.json"),
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
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# Focus\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);
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
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeFile(join(agenticsRepoDir, "skills", "focus", "old.md"), "old\n");
    await writeJawfishConfig(context, agenticsRepoDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );

    const firstInstall = await runJawfish(context, ["install"]);

    assert.equal(firstInstall.exitCode, 0, firstInstall.stderr);
    await rm(join(installDir, "SKILL.md"));
    await writeFile(join(installDir, "user.md"), "manual\n");
    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# New Focus\n",
    );
    await rm(join(agenticsRepoDir, "skills", "focus", "old.md"));

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
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await runJawfish(context, ["install"]);
    await writeFile(join(installDir, "notes.md"), "manual\n");
    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "notes.md"),
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
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
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

  test("imports a local prompt package, pushes the repo, and installs it", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");
    const sourceDir = join(context.rootDir, "daily-brief");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "brief.md"), "Summarize today's work.\n");
    await writeFile(join(sourceDir, "notes.txt"), "Keep it concise.\n");
    await writeJawfishConfig(context, agenticsRepoDir);

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
      JSON.parse(await readFile(join(agenticsRepoDir, "index.json"), "utf8")),
      {
        "daily-brief": {
          description: "",
          path: "prompts/daily-brief",
          type: "prompt",
          upstream: join(sourceDir, "brief.md"),
        },
      },
    );

    const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
  });

  test("imports into a local git repo without a push destination", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const sourceDir = join(context.rootDir, "focus");

    await createGitRepository(agenticsRepoDir);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Focus\n");
    await writeJawfishConfig(context, agenticsRepoDir);

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
      JSON.parse(await readFile(join(agenticsRepoDir, "index.json"), "utf8")),
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

  test("reuses a renamed local source when installing another scope", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const sourceDir = join(context.rootDir, "focus");

    await createGitRepository(agenticsRepoDir);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Focus\n");
    await writeJawfishConfig(context, agenticsRepoDir);

    const projectResult = await runJawfish(context, [
      "add",
      "--name",
      "renamed-focus",
      sourceDir,
    ]);
    assert.equal(projectResult.exitCode, 0, projectResult.stderr);

    const globalResult = await runJawfish(context, ["add", "-g", sourceDir]);

    assert.equal(globalResult.exitCode, 0, globalResult.stderr);
    assert.match(globalResult.stdout, /Added renamed-focus to global/);
    await assertJsonFile(join(agenticsRepoDir, "index.json"), {
      "renamed-focus": {
        description: "",
        path: "skills/renamed-focus",
        type: "skill",
        upstream: sourceDir,
      },
    });
    await assertCodexScopeConfigs(context, "renamed-focus");
  });

  test("imports a URL file parent package, pushes the repo, and installs it", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");
    const sourceDir = join(context.rootDir, "upstream-focus");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Focus\n");
    await writeFile(
      join(sourceDir, "references.md"),
      "Use deep work blocks.\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

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
      await assertJsonFile(join(agenticsRepoDir, "index.json"), {
        "upstream-focus": {
          description: "",
          path: "skills/upstream-focus",
          type: "skill",
          upstream: sourceUrl,
        },
      });

      const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
      const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
      assert.equal(localHead.stdout, remoteHead.stdout);
    } finally {
      await server.close();
    }
  });

  test("reuses a renamed URL file source when installing another scope", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const sourceDir = join(context.rootDir, "upstream-focus");

    await createGitRepository(agenticsRepoDir);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Focus\n");
    await writeJawfishConfig(context, agenticsRepoDir);

    const server = await serveStaticDirectory(context.rootDir);
    const sourceUrl = `${server.url}/upstream-focus/SKILL.md`;
    try {
      const projectResult = await runJawfish(context, [
        "add",
        "--name",
        "renamed-url-focus",
        sourceUrl,
      ]);
      assert.equal(projectResult.exitCode, 0, projectResult.stderr);

      const globalResult = await runJawfish(context, ["add", "-g", sourceUrl]);

      assert.equal(globalResult.exitCode, 0, globalResult.stderr);
      assert.match(globalResult.stdout, /Added renamed-url-focus to global/);
      await assertJsonFile(join(agenticsRepoDir, "index.json"), {
        "renamed-url-focus": {
          description: "",
          path: "skills/renamed-url-focus",
          type: "skill",
          upstream: sourceUrl,
        },
      });
      await assertCodexScopeConfigs(context, "renamed-url-focus");
    } finally {
      await server.close();
    }
  });

  test("imports a URL file when the parent URL cannot be listed", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await writeJawfishConfig(context, agenticsRepoDir);

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
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");
    const sourceDir = join(context.rootDir, "review-agent");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "AGENT.md"), "# Review Agent\n");
    await writeFile(join(sourceDir, "checklist.md"), "Check tests.\n");
    await writeJawfishConfig(context, agenticsRepoDir);

    const server = await serveStaticDirectory(context.rootDir);
    const sourceUrl = `${server.url}/review-agent`;
    try {
      const result = await runJawfish(context, ["add", sourceUrl]);

      assert.equal(result.exitCode, 0, result.stderr);
      const globalResult = await runJawfish(context, ["add", "-g", sourceUrl]);

      assert.equal(globalResult.exitCode, 0, globalResult.stderr);
      assert.match(globalResult.stdout, /Added review-agent to global/);
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
      await assertJsonFile(join(agenticsRepoDir, "index.json"), {
        "review-agent": {
          description: "",
          path: "agents/review-agent",
          type: "agent",
          upstream: sourceUrl,
        },
      });
      await assertCodexScopeConfigs(context, "review-agent");
    } finally {
      await server.close();
    }
  });

  test("failed URL source imports leave no catalog entry", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);

    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("boom\n");
    });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    try {
      const sourceUrl = `http://127.0.0.1:${address.port}/broken-skill`;
      const result = await runJawfish(context, ["add", sourceUrl]);

      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Failed to fetch .*500 Internal Server Error/);
      await assert.rejects(
        readFile(join(agenticsRepoDir, "index.json"), "utf8"),
        /ENOENT/,
      );
    } finally {
      await closeServer(server);
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
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");
    const sourceDir = join(context.rootDir, "scratch-agent");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "README.md"), "# Scratch\n");
    await writeFile(join(sourceDir, "notes.txt"), "Act carefully.\n");
    await writeJawfishConfig(context, agenticsRepoDir);

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
      JSON.parse(await readFile(join(agenticsRepoDir, "index.json"), "utf8")),
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
    const { agenticsRepoDir, remoteDir } = await setupUpstreamFocusAgenticsRepo(context, {
      catalogFile: "catalog.json",
      staleFile: true,
    });
    await writeJawfishConfig(context, agenticsRepoDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    await runJawfish(context, ["install"]);
    await writeFile(
      join(context.projectDir, ".codex", "skills", "focus", "notes.md"),
      "manual\n",
    );

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
      readFile(
        join(context.projectDir, ".codex", "skills", "focus", "stale.md"),
        "utf8",
      ),
      /ENOENT/,
    );
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "skills", "focus", "notes.md"),
        "utf8",
      ),
      "manual\n",
    );
    await assert.rejects(
      readFile(join(agenticsRepoDir, "skills", "focus", "stale.md"), "utf8"),
      /ENOENT/,
    );
    const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
  });

  test("fails to update a package without upstream metadata", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Agentic has no upstream: focus/);
  });

  test("updates from a file upstream by replacing with the parent directory", async () => {
    const context = await setup();
    const upstreamDir = join(context.rootDir, "upstream-focus");
    const { agenticsRepoDir } = await setupUpstreamFocusAgenticsRepo(context, {
      staleFile: true,
      upstream: join(upstreamDir, "SKILL.md"),
    });
    await writeFile(
      join(upstreamDir, "references.md"),
      "Use deep work blocks.\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(
        join(agenticsRepoDir, "skills", "focus", "references.md"),
        "utf8",
      ),
      "Use deep work blocks.\n",
    );
    await assert.rejects(
      readFile(join(agenticsRepoDir, "skills", "focus", "stale.md"), "utf8"),
      /ENOENT/,
    );
  });

  test("aborts update when the local package has dirty changes", async () => {
    const context = await setup();
    const { agenticsRepoDir } = await setupUpstreamFocusAgenticsRepo(context, {
      pushRemote: false,
    });
    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Package has dirty local changes: focus/);
    assert.match(result.stderr, /skills\/focus\/SKILL\.md/);
    assert.match(result.stderr, /jawfish update --force focus/);
    assert.equal(
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Dirty\n",
    );
  });

  test("force flags update a package with dirty local changes", async () => {
    const context = await setup();
    const { agenticsRepoDir, upstreamDir } =
      await setupUpstreamFocusAgenticsRepo(context);
    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update", "-F", "focus"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );

    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
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
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Newer\n",
    );
  });

  test("push failure leaves the update commit intact with recovery guidance", async () => {
    const context = await setup();
    const { agenticsRepoDir, remoteDir } = await setupUpstreamFocusAgenticsRepo(context);
    await writeFile(
      join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\necho rejected by test >&2\nexit 1\n",
    );
    await chmod(join(remoteDir, "hooks", "pre-receive"), 0o755);
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Agentics repo commit was created, but push failed/);
    assert.match(result.stderr, /rejected by test/);
    assert.match(result.stderr, /git -C .* push/);

    const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const commitMessage = await git(agenticsRepoDir, ["log", "-1", "--pretty=%s"]);
    assert.notEqual(localHead.stdout, remoteHead.stdout);
    assert.equal(commitMessage.stdout.trim(), "update focus");
  });

  test("update reinstalls only in the selected scope when already installed", async () => {
    const context = await setup();
    const { agenticsRepoDir } = await setupUpstreamFocusAgenticsRepo(context);
    const codexHome = join(context.rootDir, "codex-home");
    const env = { CODEX_HOME: codexHome };

    await writeJawfishConfig(context, agenticsRepoDir);
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

  test("update aborts before committing when selected reinstall conflicts with unmanaged files", async () => {
    const context = await setup();
    const { agenticsRepoDir, remoteDir, upstreamDir } =
      await setupUpstreamFocusAgenticsRepo(context);
    const installDir = join(context.projectDir, ".codex", "skills", "focus");

    await writeFile(join(upstreamDir, "notes.md"), "managed\n");
    await writeJawfishConfig(context, agenticsRepoDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { focus: { tool: "codex" } } }, null, 2),
    );
    assert.equal((await runJawfish(context, ["install"])).exitCode, 0);
    await writeFile(join(installDir, "notes.md"), "manual\n");

    const initialHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const initialRemoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const result = await runJawfish(context, ["update", "focus"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unmanaged destination file/);
    assert.equal(
      await readFile(join(installDir, "notes.md"), "utf8"),
      "manual\n",
    );
    assert.equal(
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Old\n",
    );
    await assert.rejects(
      readFile(join(agenticsRepoDir, "skills", "focus", "notes.md"), "utf8"),
      /ENOENT/,
    );
    assert.equal(
      (await git(agenticsRepoDir, ["rev-parse", "HEAD"])).stdout,
      initialHead.stdout,
    );
    assert.equal(
      (await git(remoteDir, ["rev-parse", "HEAD"])).stdout,
      initialRemoteHead.stdout,
    );
  });

  test("bulk update reports updated and skipped packages", async () => {
    const context = await setup();
    const { agenticsRepoDir } = await setupBulkUpdateAgenticsRepo(context, {
      includeSkipped: true,
    });
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stdout, /Skipped: scratch/);
    assert.match(result.stdout, /Failed: none/);
    assert.equal(
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );
    assert.equal(
      await readFile(join(agenticsRepoDir, "prompts", "plan", "plan.md"), "utf8"),
      "New plan\n",
    );
  });

  test("bulk update commits and pushes all upstream packages", async () => {
    const context = await setup();
    const { agenticsRepoDir, remoteDir } = await setupBulkUpdateAgenticsRepo(context);
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stdout, /Skipped: none/);
    const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const commitMessage = await git(agenticsRepoDir, ["log", "-1", "--pretty=%s"]);
    assert.equal(localHead.stdout, remoteHead.stdout);
    assert.equal(commitMessage.stdout.trim(), "update jawfish");
  });

  test("bulk update reports dirty packages as failed without committing", async () => {
    const context = await setup();
    const { agenticsRepoDir } = await setupBulkUpdateAgenticsRepo(context);
    const initialHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

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
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# Dirty\n",
    );
    const finalHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    assert.equal(finalHead.stdout, initialHead.stdout);
  });

  test("force bulk update replaces dirty packages", async () => {
    const context = await setup();
    const { agenticsRepoDir } = await setupBulkUpdateAgenticsRepo(context);
    await writeFile(
      join(agenticsRepoDir, "skills", "focus", "SKILL.md"),
      "# Dirty\n",
    );
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update", "-F"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stdout, /Failed: none/);
    assert.equal(
      await readFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "utf8"),
      "# New\n",
    );
  });

  test("bulk update reinstalls updated packages only in the selected scope", async () => {
    const context = await setup();
    const { agenticsRepoDir } = await setupBulkUpdateAgenticsRepo(context);
    const codexHome = join(context.rootDir, "codex-home");
    const env = { CODEX_HOME: codexHome };

    await writeJawfishConfig(context, agenticsRepoDir);
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
    const { agenticsRepoDir, remoteDir } = await setupBulkUpdateAgenticsRepo(context);
    await writeFile(
      join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\necho rejected by test >&2\nexit 1\n",
    );
    await chmod(join(remoteDir, "hooks", "pre-receive"), 0o755);
    await writeJawfishConfig(context, agenticsRepoDir);

    const result = await runJawfish(context, ["update"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /Updated: focus, plan/);
    assert.match(result.stderr, /Agentics repo commit was created, but push failed/);
    assert.match(result.stderr, /git -C .* push/);
    const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    const commitMessage = await git(agenticsRepoDir, ["log", "-1", "--pretty=%s"]);
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
      "list",
      "update",
      "upgrade",
      "remove",
    ]) {
      const result = await runJawfish(context, [command, "--help"]);

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`Usage: jawfish ${command}`));
    }
  });

  test("lists catalog entries as a table or JSON", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.homeDir, "agentics");

    await writeJawfishConfig(context, agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "skills", "handoff"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "agents", "review"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "agents", "survey"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "index.json"),
      JSON.stringify(
        {
          handoff: {
            description: "Compact current conversation",
            path: "skills/handoff",
            type: "skill",
          },
          review: {
            description: "Review changes",
            path: "agents/review",
            type: "agent",
          },
          survey: {
            description: "Survey repo",
            path: "agents/survey",
            type: "agent",
          },
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
      join(context.projectDir, "jawfish.json"),
      JSON.stringify(
        {
          jawfish: {
            focus: { tool: "codex" },
            review: { tool: "codex" },
            ghost: { tool: "codex" },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(context.homeDir, "jawfish.json"),
      JSON.stringify(
        {
          jawfish: {
            handoff: { tool: "codex" },
            review: { tool: "codex" },
          },
        },
        null,
        2,
      ),
    );

    const table = await runJawfish(context, ["list"]);
    assert.equal(table.exitCode, 0, table.stderr);
    assert.match(table.stdout, /┌/);
    assert.match(
      table.stdout,
      /│ name\s+│ type\s+│ installed\s+│ description/,
    );
    assert.match(
      table.stdout,
      /│ focus\s+│ skill\s+│ project\s+│ Focus workflow/,
    );
    assert.match(
      table.stdout,
      /│ handoff\s+│ skill\s+│ global\s+│ Compact current conversation/,
    );
    assert.match(
      table.stdout,
      /│ review\s+│ agent\s+│ both\s+│ Review changes/,
    );
    assert.match(table.stdout, /│ survey\s+│ agent\s+│ -\s+│ Survey repo/);
    assert.doesNotMatch(table.stdout, /ghost/);
    assert.ok(table.stdout.indexOf("focus") < table.stdout.indexOf("handoff"));
    assert.ok(table.stdout.indexOf("handoff") < table.stdout.indexOf("review"));

    const raw = await runJawfish(context, ["list", "--raw"]);
    assert.equal(raw.exitCode, 0, raw.stderr);
    assert.deepEqual(JSON.parse(raw.stdout), [
      {
        description: "Focus workflow",
        installed: "project",
        name: "focus",
        path: "~/agentics/skills/focus",
        type: "skill",
      },
      {
        description: "Compact current conversation",
        installed: "global",
        name: "handoff",
        path: "~/agentics/skills/handoff",
        type: "skill",
      },
      {
        description: "Review changes",
        installed: "both",
        name: "review",
        path: "~/agentics/agents/review",
        type: "agent",
      },
      {
        description: "Survey repo",
        installed: "-",
        name: "survey",
        path: "~/agentics/agents/survey",
        type: "agent",
      },
    ]);

    const skills = await runJawfish(context, ["list", "--type", "skill"]);
    assert.equal(skills.exitCode, 0, skills.stderr);
    assert.match(skills.stdout, /focus/);
    assert.match(skills.stdout, /handoff/);
    assert.doesNotMatch(skills.stdout, /review/);
    assert.doesNotMatch(skills.stdout, /survey/);

    const projectInstalled = await runJawfish(context, [
      "list",
      "--installed",
      "project",
    ]);
    assert.equal(projectInstalled.exitCode, 0, projectInstalled.stderr);
    assert.match(projectInstalled.stdout, /focus/);
    assert.match(projectInstalled.stdout, /review/);
    assert.doesNotMatch(projectInstalled.stdout, /handoff/);
    assert.doesNotMatch(projectInstalled.stdout, /survey/);

    const globalInstalled = await runJawfish(context, [
      "list",
      "--installed",
      "global",
    ]);
    assert.equal(globalInstalled.exitCode, 0, globalInstalled.stderr);
    assert.match(globalInstalled.stdout, /handoff/);
    assert.match(globalInstalled.stdout, /review/);
    assert.doesNotMatch(globalInstalled.stdout, /focus/);
    assert.doesNotMatch(globalInstalled.stdout, /survey/);

    const bothInstalled = await runJawfish(context, [
      "list",
      "--installed",
      "both",
    ]);
    assert.equal(bothInstalled.exitCode, 0, bothInstalled.stderr);
    assert.match(bothInstalled.stdout, /review/);
    assert.doesNotMatch(bothInstalled.stdout, /focus/);
    assert.doesNotMatch(bothInstalled.stdout, /handoff/);
    assert.doesNotMatch(bothInstalled.stdout, /survey/);

    const uninstalled = await runJawfish(context, [
      "list",
      "--installed",
      "none",
    ]);
    assert.equal(uninstalled.exitCode, 0, uninstalled.stderr);
    assert.match(uninstalled.stdout, /survey/);
    assert.doesNotMatch(uninstalled.stdout, /focus/);
    assert.doesNotMatch(uninstalled.stdout, /handoff/);
    assert.doesNotMatch(uninstalled.stdout, /review/);

    const anyInstalled = await runJawfish(context, [
      "list",
      "--installed",
      "any",
    ]);
    assert.equal(anyInstalled.exitCode, 0, anyInstalled.stderr);
    assert.match(anyInstalled.stdout, /focus/);
    assert.match(anyInstalled.stdout, /handoff/);
    assert.match(anyInstalled.stdout, /review/);
    assert.doesNotMatch(anyInstalled.stdout, /survey/);

    const projectSkills = await runJawfish(context, [
      "list",
      "--type",
      "skill",
      "--installed",
      "project",
    ]);
    assert.equal(projectSkills.exitCode, 0, projectSkills.stderr);
    assert.match(projectSkills.stdout, /focus/);
    assert.doesNotMatch(projectSkills.stdout, /handoff/);
    assert.doesNotMatch(projectSkills.stdout, /review/);
    assert.doesNotMatch(projectSkills.stdout, /survey/);

    const rawUninstalled = await runJawfish(context, [
      "list",
      "--installed",
      "none",
      "--raw",
    ]);
    assert.equal(rawUninstalled.exitCode, 0, rawUninstalled.stderr);
    assert.deepEqual(
      JSON.parse(rawUninstalled.stdout).map(
        (entry: { name: string }) => entry.name,
      ),
      ["survey"],
    );

    const empty = await runJawfish(context, ["list", "--type", "prompt"]);
    assert.equal(empty.exitCode, 0, empty.stderr);
    assert.match(
      empty.stdout,
      /│ name\s+│ type\s+│ installed\s+│ description/,
    );
    assert.doesNotMatch(empty.stdout, /focus|handoff|review|survey/);
  });

  test("rejects unsupported list type", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.homeDir, "agentics");

    await writeJawfishConfig(context, agenticsRepoDir);
    const result = await runJawfish(context, ["list", "--type", "script"]);

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /Unsupported type: script\. Supported types: skill, agent, prompt/,
    );
  });

  test("rejects unsupported list installed filter", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.homeDir, "agentics");

    await writeJawfishConfig(context, agenticsRepoDir);
    const result = await runJawfish(context, [
      "list",
      "--installed",
      "local",
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /Unsupported installed filter: local\. Supported filters: project, global, both, none, any/,
    );
  });

  test("adds a URL source with no configured agentics repo", async () => {
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
          agenticsRepo: join(context.homeDir, "agentics"),
          defaultTool: "codex",
        },
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(context.homeDir, "agentics", "index.json"),
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

  test("init -y creates minimum machine setup from env defaults", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "env-agentics");

    const result = await runJawfish(context, ["init", "-y"], {
      env: {
        JAWFISH_AGENTICS_REPO: agenticsRepoDir,
        JAWFISH_DEFAULT_TOOL: "hermes",
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Initialized jawfish/);
    assert.deepEqual(
      JSON.parse(await readFile(configPath(context.homeDir), "utf8")),
      {
        agenticsRepo: agenticsRepoDir,
        defaultTool: "hermes",
      },
    );
    await stat(join(agenticsRepoDir, ".git"));
    assert.match(
      await readFile(join(agenticsRepoDir, ".gitignore"), "utf8"),
      /config\.json/,
    );
    assert.match(
      await readFile(join(agenticsRepoDir, ".gitignore"), "utf8"),
      /jawfish\.json/,
    );
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assert.rejects(
      readFile(join(context.projectDir, "jawfish.json"), "utf8"),
      { code: "ENOENT" },
    );
  });

  test("interactive init creates first-run local machine setup", async () => {
    const context = await setup();
    let promptedTools: readonly string[] = [];
    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => {
        throw new Error("unexpected repo path prompt");
      },
      selectAgenticsRepoMode: async () => "local",
      selectDefaultTool: async (tools) => {
        promptedTools = tools;
        return "hermes";
      },
      selectProjectAgentics: async () => [],
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.deepEqual(promptedTools, [...defaultSupportedTools]);
    assert.match(result.stdout, /Initialized jawfish/);
    assert.match(result.stdout, /Agentics repo inspection/);
    assert.deepEqual(
      JSON.parse(await readFile(configPath(context.homeDir), "utf8")),
      {
        agenticsRepo: join(context.homeDir, "agentics"),
        defaultTool: "hermes",
      },
    );
    await stat(join(context.homeDir, "agentics", ".git"));
    assert.match(
      await readFile(join(context.homeDir, "agentics", ".gitignore"), "utf8"),
      /config\.json/,
    );
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assertJsonFile(join(context.projectDir, "jawfish.json"), { jawfish: {} });
  });

  test("interactive init links an existing local agentics repo", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "existing-agentics");
    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => agenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "codex",
      selectProjectAgentics: async () => [],
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.match(result.stdout, /Usable: focus/);
    assert.deepEqual(
      JSON.parse(await readFile(configPath(context.homeDir), "utf8")),
      {
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      },
    );
    assert.match(
      await readFile(join(agenticsRepoDir, ".gitignore"), "utf8"),
      /jawfish\.json/,
    );
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: {},
    });
  });

  test("interactive init exits clearly for a missing linked repo path", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "missing-agentics");

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => agenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "codex",
      selectProjectAgentics: async () => [],
    };

    await assert.rejects(
      captureConsole(() =>
        initCommand(initArgs(), {
          cwd: context.projectDir,
          env: {
            HOME: context.homeDir,
            JAWFISH_HOME: context.homeDir,
          },
          prompts,
        }),
      ),
      /Agentics repo path not found/,
    );
    await assertMissingFile(configPath(context.homeDir));
    await assertMissingFile(join(context.homeDir, "jawfish.json"));
  });

  test("interactive init installs selected global starter entries", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "starter-agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => agenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "codex",
      selectGlobalStarterAgentics: async (inspection) => {
        assert.deepEqual(inspection.usableNames, ["focus"]);
        return ["focus"];
      },
      selectImportProviders: async () => [],
      selectProjectAgentics: async () => [],
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.match(result.stdout, /Installed focus globally/);
    await assertJsonFile(join(context.homeDir, "jawfish.json"), {
      jawfish: { focus: { tool: "codex" } },
    });
    assert.equal(
      await readFile(
        join(context.homeDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      "# Focus\n\nUse focused execution.\n",
    );
  });

  test("interactive init rejects invalid starter selections before installs", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "starter-agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => agenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "codex",
      selectGlobalStarterAgentics: async () => ["focus", "missing"],
      selectImportProviders: async () => [],
      selectProjectAgentics: async () => [],
    };

    await assert.rejects(
      captureConsole(() =>
        initCommand(initArgs(), {
          cwd: context.projectDir,
          env: {
            HOME: context.homeDir,
            JAWFISH_HOME: context.homeDir,
          },
          prompts,
        }),
      ),
      /Selected agentic is not available: missing/,
    );
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assertMissingFile(
      join(context.homeDir, ".codex", "skills", "focus", "SKILL.md"),
    );
    await assertMissingFile(configPath(context.homeDir));
  });

  test("interactive init project cancellation preserves existing manifest", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify({ jawfish: { existing: { tool: "codex" } } }, null, 2),
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => {
        throw new Error("unexpected repo path prompt");
      },
      selectAgenticsRepoMode: async () => {
        throw new Error("unexpected repo mode prompt");
      },
      selectDefaultTool: async () => {
        throw new Error("unexpected default tool prompt");
      },
      selectExistingMachineInitAction: async () => "project",
      selectProjectAgentics: async () => {
        throw new Error("Project setup cancelled");
      },
    };

    await assert.rejects(
      captureConsole(() =>
        initCommand(initArgs(), {
          cwd: context.projectDir,
          env: {
            HOME: context.homeDir,
            JAWFISH_HOME: context.homeDir,
          },
          prompts,
        }),
      ),
      /Project setup cancelled/,
    );
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: { existing: { tool: "codex" } },
    });
    await assertMissingFile(
      join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
    );
  });

  test("interactive init imports before starter selection for empty repos", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "empty-agentics");
    const promptOrder: string[] = [];

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(context.homeDir, ".codex", "skills", "focus"), {
      recursive: true,
    });
    await writeFile(
      join(context.homeDir, ".codex", "skills", "focus", "SKILL.md"),
      "# Imported Focus\n",
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => agenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "codex",
      selectImportProviders: async () => {
        promptOrder.push("import");
        return ["codex"];
      },
      selectGlobalStarterAgentics: async (inspection) => {
        promptOrder.push("starter");
        assert.deepEqual(inspection.usableNames, ["focus"]);
        return ["focus"];
      },
      selectProjectAgentics: async () => [],
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.deepEqual(promptOrder, ["import", "starter"]);
    assert.match(result.stdout, /Imported 1 skills from codex/);
    assert.match(result.stdout, /Installed focus globally/);
    await assertJsonFile(join(agenticsRepoDir, "index.json"), {
      focus: {
        description: "",
        path: "skills/focus",
        type: "skill",
      },
    });
    await assertJsonFile(join(context.homeDir, "jawfish.json"), {
      jawfish: { focus: { tool: "codex" } },
    });
  });

  test("interactive init rejects invalid import providers before imports", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "empty-agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(context.homeDir, ".codex", "skills", "focus"), {
      recursive: true,
    });
    await writeFile(
      join(context.homeDir, ".codex", "skills", "focus", "SKILL.md"),
      "# Imported Focus\n",
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => agenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "codex",
      selectImportProviders: async () => ["codex", "unknown"],
      selectProjectAgentics: async () => [],
    };

    await assert.rejects(
      captureConsole(() =>
        initCommand(initArgs(), {
          cwd: context.projectDir,
          env: {
            HOME: context.homeDir,
            JAWFISH_HOME: context.homeDir,
          },
          prompts,
        }),
      ),
      /Unsupported selected import provider: unknown/,
    );
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assertMissingFile(join(agenticsRepoDir, "index.json"));
    await assertMissingFile(configPath(context.homeDir));
  });

  test("interactive init links and inspects a git agentics repo", async () => {
    const context = await setup();
    const remoteDir = await createAgenticsRepoRemote(context, {
      "demo-skill": {
        type: "skill",
        description: "Demo skill",
        path: "skills/demo-skill",
      },
    });

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => remoteDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => "opencode",
      selectProjectAgentics: async () => [],
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.match(result.stdout, /Usable: demo-skill/);
    assert.deepEqual(
      JSON.parse(await readFile(configPath(context.homeDir), "utf8")),
      {
        agenticsRepo: remoteDir,
        defaultTool: "opencode",
      },
    );
    await stat(join(context.homeDir, "agentics", ".git"));
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: {},
    });
  });

  test("interactive init cancel exits without machine writes", async () => {
    const context = await setup();
    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => {
        throw new Error("unexpected repo path prompt");
      },
      selectAgenticsRepoMode: async () => {
        throw new Error("unexpected repo mode prompt");
      },
      selectDefaultTool: async () => {
        throw new Error("No tool selected");
      },
    };

    await assert.rejects(
      captureConsole(() =>
        initCommand(initArgs(), {
          cwd: context.projectDir,
          env: {
            HOME: context.homeDir,
            JAWFISH_HOME: context.homeDir,
          },
          prompts,
        }),
      ),
      /No tool selected/,
    );
    await assert.rejects(readFile(configPath(context.homeDir), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(context.homeDir, "jawfish.json"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(stat(join(context.homeDir, "agentics")), {
      code: "ENOENT",
    });
  });

  test("init -y with machine config creates only the project manifest", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["init", "--yes"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Initialized project/);
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: {},
    });
    await assert.rejects(
      readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(join(context.homeDir, "jawfish.json"), "utf8"),
      { code: "ENOENT" },
    );
  });

  test("init -y repeated runs do not install or import catalog entries", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);

    const env = {
      JAWFISH_AGENTICS_REPO: agenticsRepoDir,
      JAWFISH_DEFAULT_TOOL: "codex",
    };

    const first = await runJawfish(context, ["init", "-y"], { env });
    const second = await runJawfish(context, ["init", "-y"], { env });
    const third = await runJawfish(context, ["init", "-y"], { env });

    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(third.exitCode, 0, third.stderr);
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: {},
    });
    await assertMissingFile(
      join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
    );
    await assertMissingFile(
      join(context.homeDir, ".codex", "skills", "focus", "SKILL.md"),
    );
  });

  test("init inspects registered and unregistered agentics repo entries", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "agents", "review"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "prompts", "plan"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "skills", "draft"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "agents", "empty"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "index.json"),
      JSON.stringify(
        {
          focus: {
            description: "Focus workflow",
            path: "skills/focus",
            type: "skill",
          },
          review: {
            description: "Review changes",
            path: "agents/review",
            type: "agent",
          },
          plan: {
            description: "Plan prompt",
            path: "prompts/plan",
            type: "prompt",
          },
          missing: {
            description: "Missing package",
            path: "skills/missing",
            type: "skill",
          },
          bad: {
            description: 1,
            path: "skills/bad",
            type: "skill",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "# Focus\n");
    await writeFile(join(agenticsRepoDir, "agents", "review", "AGENT.md"), "# Review\n");
    await writeFile(join(agenticsRepoDir, "prompts", "plan", "plan.md"), "Plan\n");
    await writeFile(join(agenticsRepoDir, "skills", "draft", "SKILL.md"), "# Draft\n");
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["init", "--yes"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Agentics repo inspection/);
    assert.match(result.stdout, /Catalog: .*index\.json/);
    assert.match(result.stdout, /Counts: 2 skills, 1 agent, 1 prompt/);
    assert.match(result.stdout, /Usable: focus, plan, review/);
    assert.match(result.stdout, /Broken: bad: bad\.description/);
    assert.match(result.stdout, /Broken: missing: path not found: skills\/missing/);
    assert.match(result.stdout, /Skipped: skills\/draft: not registered/);
    assert.match(result.stdout, /Skipped: agents\/empty: empty package/);
  });

  test("init inspects legacy catalog entries", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "catalog.json"),
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
    await writeFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "# Focus\n");
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["init", "--yes"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Catalog: .*catalog\.json/);
    assert.match(result.stdout, /Counts: 1 skill, 0 agents, 0 prompts/);
    assert.match(result.stdout, /Usable: focus/);
  });

  test("interactive init installs selected project entries and preserves omitted existing entries", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await mkdir(join(agenticsRepoDir, "skills", "focus"), { recursive: true });
    await mkdir(join(agenticsRepoDir, "agents", "review"), { recursive: true });
    await writeFile(
      join(agenticsRepoDir, "index.json"),
      JSON.stringify(
        {
          focus: {
            description: "Focus workflow",
            path: "skills/focus",
            type: "skill",
          },
          review: {
            description: "Review changes",
            path: "agents/review",
            type: "agent",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(agenticsRepoDir, "skills", "focus", "SKILL.md"), "# Focus\n");
    await writeFile(join(agenticsRepoDir, "agents", "review", "AGENT.md"), "# Review\n");
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      JSON.stringify(
        {
          jawfish: {
            focus: { tool: "codex" },
            ghost: { tool: "codex" },
          },
        },
        null,
        2,
      ),
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => {
        throw new Error("unexpected repo path prompt");
      },
      selectAgenticsRepoMode: async () => {
        throw new Error("unexpected repo mode prompt");
      },
      selectDefaultTool: async () => {
        throw new Error("unexpected default tool prompt");
      },
      selectExistingMachineInitAction: async (hasProjectManifest) => {
        assert.equal(hasProjectManifest, true);
        return "project";
      },
      selectProjectAgentics: async (inspection, manifest) => {
        assert.deepEqual(inspection.usableNames, ["focus", "review"]);
        assert.deepEqual(manifest.jawfish, {
          focus: { tool: "codex" },
          ghost: { tool: "codex" },
        });
        return ["review"];
      },
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.match(result.stdout, /Initialized project/);
    assert.match(result.stdout, /Installed review to project/);
    assert.deepEqual(
      JSON.parse(await readFile(join(context.projectDir, "jawfish.json"), "utf8")),
      {
        jawfish: {
          focus: { tool: "codex" },
          ghost: { tool: "codex" },
          review: { tool: "codex" },
        },
      },
    );
    assert.equal(
      await readFile(
        join(context.projectDir, ".codex", "agents", "review", "AGENT.md"),
        "utf8",
      ),
      "# Review\n",
    );
    await assert.rejects(
      readFile(
        join(context.projectDir, ".codex", "skills", "focus", "SKILL.md"),
        "utf8",
      ),
      { code: "ENOENT" },
    );
  });

  test("interactive init continues to project setup after first machine setup", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);

    const result = await runJawfish(context, ["init"], {
      env: {
        JAWFISH_AGENTICS_REPO: agenticsRepoDir,
        JAWFISH_DEFAULT_TOOL: "codex",
      },
      input: " \r",
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Initialized jawfish/);
    assert.match(result.stdout, /Initialized project/);
    assert.match(result.stdout, /Installed focus to project/);
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: { focus: { tool: "codex" } },
    });
  });

  test("interactive init with empty registered repo ensures project manifest", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");

    await createGitRepository(agenticsRepoDir);
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["init"], { input: "\r" });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /No registered agentics are selectable/);
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: {},
    });
  });

  test("interactive init reinitializes existing machine default tool", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const actions: Array<"default-tool" | "done"> = ["default-tool", "done"];
    const seenProjectManifestStates: boolean[] = [];

    await createGitRepository(agenticsRepoDir);
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => {
        throw new Error("unexpected repo path prompt");
      },
      selectAgenticsRepoMode: async () => {
        throw new Error("unexpected repo mode prompt");
      },
      selectDefaultTool: async () => "hermes",
      selectExistingMachineInitAction: async (hasProjectManifest) => {
        seenProjectManifestStates.push(hasProjectManifest);
        return "reinitialize";
      },
      selectMachineReinitializeAction: async () => {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
      selectProjectAgentics: async () => {
        throw new Error("unexpected project setup prompt");
      },
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.deepEqual(seenProjectManifestStates, [false]);
    assert.match(result.stdout, /Current machine config/);
    assert.match(result.stdout, /Default tool: codex/);
    assert.match(result.stdout, /Updated default tool: hermes/);
    assert.deepEqual(JSON.parse(await readFile(configPath(context.homeDir), "utf8")), {
      agenticsRepo: agenticsRepoDir,
      defaultTool: "hermes",
    });
    await assertJsonFile(join(context.homeDir, "jawfish.json"), { jawfish: {} });
    await assert.rejects(readFile(join(context.projectDir, "jawfish.json"), "utf8"), {
      code: "ENOENT",
    });
  });

  test("interactive init reinitializes repo link from existing project manifest", async () => {
    const context = await setup();
    const oldAgenticsRepoDir = join(context.rootDir, "old-agentics");
    const newAgenticsRepoDir = join(context.rootDir, "new-agentics");
    const actions: Array<"agentics-repo" | "done"> = ["agentics-repo", "done"];
    const seenProjectManifestStates: boolean[] = [];

    await createGitRepository(oldAgenticsRepoDir);
    await createGitRepository(newAgenticsRepoDir);
    await writeIndexedFocusSkill(newAgenticsRepoDir);
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: oldAgenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );
    await writeFile(
      join(context.projectDir, "jawfish.json"),
      `${JSON.stringify({ jawfish: { existing: { tool: "codex" } } })}\n`,
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => newAgenticsRepoDir,
      selectAgenticsRepoMode: async () => "link",
      selectDefaultTool: async () => {
        throw new Error("unexpected default tool prompt");
      },
      selectExistingMachineInitAction: async (hasProjectManifest) => {
        seenProjectManifestStates.push(hasProjectManifest);
        return "reinitialize";
      },
      selectMachineReinitializeAction: async () => {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
      selectProjectAgentics: async () => {
        throw new Error("unexpected project setup prompt");
      },
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.deepEqual(seenProjectManifestStates, [true]);
    assert.match(result.stdout, /Updated agentics repo/);
    assert.match(result.stdout, /Usable: focus/);
    assert.deepEqual(JSON.parse(await readFile(configPath(context.homeDir), "utf8")), {
      agenticsRepo: newAgenticsRepoDir,
      defaultTool: "codex",
    });
    await assertJsonFile(join(context.projectDir, "jawfish.json"), {
      jawfish: { existing: { tool: "codex" } },
    });
    await stat(join(oldAgenticsRepoDir, "README.md"));
  });

  test("interactive init reinitialize menu installs starters and imports skills", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const actions: Array<"global-starters" | "import-skills" | "done"> = [
      "global-starters",
      "import-skills",
      "done",
    ];

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await mkdir(join(context.homeDir, ".codex", "skills", "imported"), {
      recursive: true,
    });
    await writeFile(
      join(context.homeDir, ".codex", "skills", "imported", "SKILL.md"),
      "# Imported\n",
    );
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: agenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const prompts: InitCommandPrompts = {
      inputAgenticsRepo: async () => {
        throw new Error("unexpected repo path prompt");
      },
      selectAgenticsRepoMode: async () => {
        throw new Error("unexpected repo mode prompt");
      },
      selectDefaultTool: async () => {
        throw new Error("unexpected default tool prompt");
      },
      selectExistingMachineInitAction: async () => "reinitialize",
      selectGlobalStarterAgentics: async (inspection) => {
        assert.deepEqual(inspection.usableNames, ["focus"]);
        return ["focus"];
      },
      selectImportProviders: async () => ["codex"],
      selectMachineReinitializeAction: async () => {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
      selectProjectAgentics: async () => {
        throw new Error("unexpected project setup prompt");
      },
    };

    const result = await captureConsole(() =>
      initCommand(initArgs(), {
        cwd: context.projectDir,
        env: {
          CODEX_HOME: join(context.homeDir, ".codex"),
          HOME: context.homeDir,
          JAWFISH_HOME: context.homeDir,
        },
        prompts,
      }),
    );

    assert.equal(result.result, 0, result.stderr);
    assert.match(result.stdout, /Installed focus globally/);
    assert.match(result.stdout, /Imported 1 skills from codex/);
    await assertJsonFile(join(context.homeDir, "jawfish.json"), {
      jawfish: {
        focus: { tool: "codex" },
        imported: { tool: "codex" },
      },
    });
    await assertJsonFile(join(agenticsRepoDir, "index.json"), {
      focus: {
        description: "Focus workflow",
        path: "skills/focus",
        type: "skill",
      },
      imported: {
        description: "",
        path: "skills/imported",
        type: "skill",
      },
    });
  });

  test("init rejects positional args and unsupported options with init usage", async () => {
    const context = await setup();

    for (const args of [
      ["init", "git@example.com:you/agentics.git"],
      ["init", "--raw"],
    ]) {
      const result = await runJawfish(context, args);

      assert.equal(result.exitCode, 1, args.join(" "));
      assert.match(result.stderr, /Usage: jawfish init \[options\]/);
    }
  });

  test("prints a clear error for an unknown catalog name in an empty local agentics repo", async () => {
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

  test("rejects unrelated options before running commands", async () => {
    const context = await setup();
    const agenticsRepoDir = join(context.rootDir, "agentics");
    const fakeBinDir = join(context.rootDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const logPath = join(context.rootDir, "bun-args.txt");

    await createGitRepository(agenticsRepoDir);
    await writeIndexedFocusSkill(agenticsRepoDir);
    await writeJawfishConfig(context, agenticsRepoDir);
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      fakeBun,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(logPath)}\n`,
    );
    await chmod(fakeBun, 0o755);

    const cases: Array<{
      args: string[];
      option: string;
      usage: RegExp;
    }> = [
      {
        args: ["add", "--yes", "focus"],
        option: "--yes",
        usage: /Usage: jawfish add/,
      },
      {
        args: ["install", "--yes"],
        option: "--yes",
        usage: /Usage: jawfish install/,
      },
      { args: ["i", "--yes"], option: "--yes", usage: /Usage: jawfish i/ },
      {
        args: ["import-skills", "--raw", "codex"],
        option: "--raw",
        usage: /Usage: jawfish import-skills/,
      },
      { args: ["list", "--yes"], option: "--yes", usage: /Usage: jawfish list/ },
      {
        args: ["update", "--yes"],
        option: "--yes",
        usage: /Usage: jawfish update/,
      },
      {
        args: ["remove", "--yes", "focus"],
        option: "--yes",
        usage: /Usage: jawfish remove/,
      },
      {
        args: ["upgrade", "--yes"],
        option: "--yes",
        usage: /Usage: jawfish upgrade/,
      },
    ];

    for (const testCase of cases) {
      const result = await runJawfish(context, testCase.args, {
        env: { PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
      });

      assert.equal(result.exitCode, 1, testCase.args.join(" "));
      assert.match(
        result.stderr,
        new RegExp(`Unsupported option: ${testCase.option}`),
      );
      assert.match(result.stderr, testCase.usage);
    }

    await assert.rejects(readFile(logPath, "utf8"), /ENOENT/);
  });

  test("creates first-run config with default tools and selected default tool", async () => {
    const context = await setup();
    const remoteDir = await createAgenticsRepoRemote(context, {
      "demo-skill": {
        type: "skill",
        description: "Demo skill",
        path: "skills/demo-skill",
      },
    });

    const result = await runJawfish(context, ["add", "demo-skill"], {
      env: {
        JAWFISH_AGENTICS_REPO: remoteDir,
        JAWFISH_DEFAULT_TOOL: "claude-code",
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const config = JSON.parse(
      await readFile(configPath(context.homeDir), "utf8"),
    );

    assert.deepEqual(config, {
      agenticsRepo: remoteDir,
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
    const remoteDir = await createAgenticsRepoRemote(context, {
      "demo-skill": {
        type: "skill",
        description: "Demo skill",
        path: "skills/demo-skill",
      },
    });

    const result = await runJawfish(context, ["add", "demo-skill"], {
      env: {
        JAWFISH_AGENTICS_REPO: remoteDir,
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

  test("clones configured agentics repo and reads name-keyed catalog entries", async () => {
    const context = await setup();
    const remoteDir = await createAgenticsRepoRemote(context, {
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
        agenticsRepo: remoteDir,
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

    const cloneDir = join(context.homeDir, "agentics");
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

  test("rejects the old nested managed repo path", async () => {
    const context = await setup();
    const oldAgenticsRepoDir = join(context.homeDir, "repo");
    await createGitRepository(oldAgenticsRepoDir);
    await writeIndexedFocusSkill(oldAgenticsRepoDir);
    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: oldAgenticsRepoDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["init"]);

    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /Nested agentics repo is no longer supported/,
    );
  });

  test("fails with a clear error when the catalog is invalid", async () => {
    const context = await setup();
    const remoteDir = await createAgenticsRepoRemote(context, {
      broken: {
        type: "skill",
        description: "Broken skill",
      },
    });

    await writeFile(
      configPath(context.homeDir),
      `${JSON.stringify({
        agenticsRepo: remoteDir,
        defaultTool: "codex",
      })}\n`,
    );

    const result = await runJawfish(context, ["add", "broken"]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Invalid catalog at .*index\.json: broken\.path/);
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
    const repoDir = join(context.rootDir, "agentics");
    const remoteDir = join(context.rootDir, "agentics.git");

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

async function createAgenticsRepoRemote(
  context: CliTestContext,
  catalog: Record<string, TestCatalogEntry>,
): Promise<string> {
  const repoDir = join(context.rootDir, "agentics-source");
  const remoteDir = join(context.rootDir, "agentics.git");

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
