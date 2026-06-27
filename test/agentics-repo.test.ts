import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openAgenticsRepoSession } from "../src/agentics-repo.ts";
import {
  createBareRemote,
  createCliTestContext,
  createGitRepository,
  git,
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

test("session clones a configured remote and reads the catalog", async () => {
  const context = await setup();
  const sourceDir = join(context.rootDir, "agentics-source");
  const remoteDir = join(context.rootDir, "agentics.git");

  await createGitRepository(sourceDir);
  await mkdir(join(sourceDir, "skills", "focus"), { recursive: true });
  await writeFile(join(sourceDir, "skills", "focus", "SKILL.md"), "# Focus\n");
  await writeFile(
    join(sourceDir, "index.json"),
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
  await git(sourceDir, ["add", "."]);
  await git(sourceDir, ["commit", "-m", "add focus"]);
  await createBareRemote(remoteDir);
  await git(sourceDir, ["remote", "add", "origin", remoteDir]);
  await git(sourceDir, ["push", "-u", "origin", "HEAD"]);

  const session = await openAgenticsRepoSession(
    { agenticsRepo: remoteDir, defaultTool: "codex" },
    {
      cwd: context.projectDir,
      env: { HOME: context.homeDir, JAWFISH_HOME: context.homeDir },
    },
  );

  assert.equal(session.dir, join(context.homeDir, "agentics"));
  assert.deepEqual(await session.readCatalog(), {
    jawfish: {
      focus: {
        description: "Focus workflow",
        path: "skills/focus",
        type: "skill",
      },
    },
  });
  assert.match(
    await readFile(join(session.dir, ".gitignore"), "utf8"),
    /jawfish\.json/,
  );
});
