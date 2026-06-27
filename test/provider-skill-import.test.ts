import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgenticsRepoSession } from "../src/agentics-repo.ts";
import { createBareRemote, createGitRepository, git } from "./helpers/cli.ts";
import { createMigrationImportTransaction } from "../src/provider-skill-import.ts";

interface ProviderImportTestContext {
  agenticsRepoDir: string;
  codexHome: string;
  homeDir: string;
  options: {
    cwd: string;
    env: Record<string, string>;
  };
  rootDir: string;
}

async function withProviderImportContext(
  run: (context: ProviderImportTestContext) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "jawfish-import-"));
  try {
    const homeDir = join(rootDir, "home");
    const projectDir = join(rootDir, "project");
    const codexHome = join(rootDir, "codex-home");

    await mkdir(projectDir, { recursive: true });
    await run({
      agenticsRepoDir: join(rootDir, "agentics"),
      codexHome,
      homeDir,
      options: {
        cwd: projectDir,
        env: {
          CODEX_HOME: codexHome,
          HOME: homeDir,
          JAWFISH_HOME: homeDir,
          OPENCODE_CONFIG_DIR: join(homeDir, ".config", "opencode"),
          XDG_CONFIG_HOME: join(homeDir, ".config"),
        },
      },
      rootDir,
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

async function assertMissingFile(path: string): Promise<void> {
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
}

test("migration import preview reports conflicts and skips before validating selections", async () => {
  await withProviderImportContext(async (context) => {
    const { agenticsRepoDir, codexHome, homeDir, options } = context;

    await createGitRepository(agenticsRepoDir);
    await writeFile(
      join(agenticsRepoDir, "index.json"),
      JSON.stringify(
        {
          focus: {
            description: "Existing focus",
            path: "skills/focus",
            type: "skill",
          },
        },
        null,
        2,
      ),
    );
    await mkdir(join(codexHome, "skills", "focus"), { recursive: true });
    await mkdir(join(codexHome, "skills", "broken"), { recursive: true });
    await mkdir(join(codexHome, "skills", "plan"), { recursive: true });
    await writeFile(join(codexHome, "skills", "focus", "SKILL.md"), "# Focus\n");
    await writeFile(join(codexHome, "skills", "plan", "SKILL.md"), "# Plan\n");

    const session = createAgenticsRepoSession(agenticsRepoDir);
    const transaction = await createMigrationImportTransaction(
      session,
      ["codex"],
      ["global"],
      options,
    );

    assert.deepEqual(
      transaction.preview.candidates.map((candidate) => candidate.id),
      ["codex:global:plan"],
    );
    assert.deepEqual(transaction.preview.conflicts, [
      {
        name: "focus",
        provider: "codex",
        reason: "catalog conflict",
        scope: "global",
      },
    ]);
    assert.deepEqual(transaction.preview.skipped, [
      {
        name: "broken",
        provider: "codex",
        reason: "missing SKILL.md",
        scope: "global",
      },
    ]);

    await assert.rejects(
      transaction.applySelected(["codex:global:missing"], "import skills"),
      /Selected import skill is not available: codex:global:missing/,
    );
    await assertMissingFile(
      join(agenticsRepoDir, "skills", "plan", "SKILL.md"),
    );
    await assertMissingFile(join(homeDir, "jawfish.json"));
    await assertMissingFile(
      join(codexHome, "skills", "plan", ".jawfish-managed.json"),
    );
  });
});

test("migration import transaction keeps local writes consistent when push fails", async () => {
  await withProviderImportContext(async (context) => {
    const { agenticsRepoDir, codexHome, homeDir, options, rootDir } = context;
    const remoteDir = join(rootDir, "agentics.git");
    const sourceSkillDir = join(codexHome, "skills", "focus");

    await createGitRepository(agenticsRepoDir);
    await createBareRemote(remoteDir);
    await git(agenticsRepoDir, ["remote", "add", "origin", remoteDir]);
    await git(agenticsRepoDir, ["push", "-u", "origin", "HEAD"]);
    await writeFile(
      join(remoteDir, "hooks", "pre-receive"),
      "#!/bin/sh\necho rejected by test >&2\nexit 1\n",
    );
    await chmod(join(remoteDir, "hooks", "pre-receive"), 0o755);
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(join(sourceSkillDir, "SKILL.md"), "# Focus\n");

    const session = createAgenticsRepoSession(agenticsRepoDir);
    const transaction = await createMigrationImportTransaction(
      session,
      ["codex"],
      ["global"],
      options,
    );

    assert.deepEqual(transaction.preview.providers, ["codex"]);
    assert.deepEqual(transaction.preview.scopes, ["global"]);
    assert.deepEqual(
      transaction.preview.candidates.map((candidate) => candidate.id),
      ["codex:global:focus"],
    );

    const result = await transaction.applySelected(
      ["codex:global:focus"],
      "import skills from codex",
    );

    assert.equal(result.pushed, false);
    assert.deepEqual(
      result.imported.map((candidate) => candidate.id),
      ["codex:global:focus"],
    );
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
      JSON.parse(await readFile(join(homeDir, "jawfish.json"), "utf8")),
      { jawfish: { focus: { tool: "codex" } } },
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(sourceSkillDir, ".jawfish-managed.json"), "utf8"),
      ),
      {
        files: ["SKILL.md"],
        name: "focus",
        tool: "codex",
        type: "skill",
      },
    );

    const localHead = await git(agenticsRepoDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.notEqual(localHead.stdout, remoteHead.stdout);
  });
});
