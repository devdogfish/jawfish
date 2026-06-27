import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBareRemote,
  createCliTestContext,
  createGitRepository,
  git,
  type CliTestContext,
} from "./helpers/cli.ts";
import {
  acquireSource,
  acquireRepoSource,
  catalogNameForUpstream,
  isSameUpstream,
  normalizeSourceUrl,
  planRepoSkillIntake,
} from "../src/source-intake.ts";
import { type Catalog } from "../src/catalog.ts";

const contexts: CliTestContext[] = [];

async function setup(): Promise<CliTestContext> {
  const context = await createCliTestContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

test("source intake acquires local file package metadata", async () => {
  const context = await setup();
  const sourceDir = join(context.rootDir, "daily-brief");
  const entryFile = join(sourceDir, "brief.md");

  await mkdir(sourceDir, { recursive: true });
  await writeFile(entryFile, "Summarize today's work.\n");
  await writeFile(join(sourceDir, "notes.txt"), "Keep it concise.\n");

  const acquired = await acquireSource(entryFile);

  assert.equal(acquired.entryFile, entryFile);
  assert.equal(acquired.inferredName, "daily-brief");
  assert.equal(acquired.packagePath, sourceDir);
});

test("source intake normalizes GitHub blob file URLs to raw URLs", () => {
  assert.equal(
    normalizeSourceUrl(
      "https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md",
    ),
    "https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md",
  );
});

test("source intake matches raw GitHub skill files to repo skill upstreams", () => {
  const raw =
    "https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/handoff/SKILL.md";
  const blob =
    "https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md";
  const tree =
    "https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff";
  const catalog: Catalog = {
    jawfish: {
      "renamed-handoff": {
        description: "",
        path: "skills/renamed-handoff",
        type: "skill",
        upstream: raw,
      },
    },
  };

  assert.equal(isSameUpstream(raw, tree), true);
  assert.equal(isSameUpstream(blob, tree), true);
  assert.equal(catalogNameForUpstream(catalog, tree), "renamed-handoff");
});

test("source intake models local repo skill candidates before writes", async () => {
  const context = await setup();
  const sourceRepoDir = join(context.rootDir, "skills-source");
  const sourceRemoteDir = join(context.rootDir, "skills-source.git");

  await createGitRepository(sourceRepoDir);
  await createBareRemote(sourceRemoteDir);
  await mkdir(join(sourceRepoDir, "skills", "focus"), { recursive: true });
  await mkdir(join(sourceRepoDir, "nested", "plan"), { recursive: true });
  await writeFile(join(sourceRepoDir, "skills", "focus", "SKILL.md"), "# Focus\n");
  await writeFile(join(sourceRepoDir, "nested", "plan", "SKILL.md"), "# Plan\n");
  await git(sourceRepoDir, ["add", "."]);
  await git(sourceRepoDir, ["commit", "-m", "add skills"]);
  await git(sourceRepoDir, ["remote", "add", "origin", sourceRemoteDir]);

  const catalog: Catalog = {
    jawfish: {
      focus: {
        description: "",
        path: "skills/focus",
        type: "skill",
        upstream: `${sourceRemoteDir}#skills/focus`,
      },
      plan: {
        description: "",
        path: "skills/plan",
        type: "skill",
        upstream: `${sourceRemoteDir}#other/plan`,
      },
    },
  };

  const repoSource = await acquireRepoSource(sourceRepoDir);
  if (repoSource === undefined) {
    throw new Error("Expected local repo source");
  }

  const plan = await planRepoSkillIntake(catalog, repoSource);

  assert.deepEqual(
    plan.candidates.map((candidate) => ({
      catalogName: candidate.catalogName,
      name: candidate.name,
      relativePath: candidate.relativePath,
      state: candidate.state,
      upstream: candidate.upstream,
    })),
    [
      {
        catalogName: "focus",
        name: "focus",
        relativePath: "skills/focus",
        state: "existing",
        upstream: `${sourceRemoteDir}#skills/focus`,
      },
      {
        catalogName: "plan",
        name: "plan",
        relativePath: "nested/plan",
        state: "conflict",
        upstream: `${sourceRemoteDir}#nested/plan`,
      },
    ],
  );
  assert.equal(plan.directCandidate, undefined);
  assert.deepEqual(plan.initialRelativePaths, ["skills/focus"]);

  const directRepoSource = await acquireRepoSource(
    join(sourceRepoDir, "skills", "focus", "SKILL.md"),
  );
  if (directRepoSource === undefined) {
    throw new Error("Expected direct repo source");
  }

  const directPlan = await planRepoSkillIntake(catalog, directRepoSource);

  assert.equal(directPlan.directCandidate?.relativePath, "skills/focus");
  assert.deepEqual(directPlan.initialRelativePaths, ["skills/focus"]);
});
