import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { queryListCatalog, type ListQuery } from "../src/list-query.ts";
import { type Catalog } from "../src/catalog.ts";
import { type Manifest } from "../src/install.ts";

test("list query returns sorted entries with install status", () => {
  const query = listFixture();

  assert.deepEqual(queryListCatalog(query), {
    entries: [
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
    ],
  });
});

test("list query applies type and installed filters", () => {
  const query = listFixture();
  const cases: Array<{
    filters: Pick<Partial<ListQuery>, "installed" | "type">;
    names: string[];
  }> = [
    { filters: { installed: "project" }, names: ["focus", "review"] },
    { filters: { installed: "global" }, names: ["handoff", "review"] },
    { filters: { installed: "both" }, names: ["review"] },
    { filters: { installed: "none" }, names: ["survey"] },
    { filters: { installed: "any" }, names: ["focus", "handoff", "review"] },
    { filters: { type: "skill" }, names: ["focus", "handoff"] },
    {
      filters: { installed: "project", type: "skill" },
      names: ["focus"],
    },
  ];

  for (const { filters, names } of cases) {
    assert.deepEqual(
      queryListCatalog({ ...query, ...filters }).entries.map(
        (entry) => entry.name,
      ),
      names,
    );
  }
});

function listFixture(): ListQuery {
  const catalog: Catalog = {
    jawfish: {
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
      review: {
        description: "Review changes",
        path: "agents/review",
        type: "agent",
      },
      handoff: {
        description: "Compact current conversation",
        path: "skills/handoff",
        type: "skill",
      },
    },
  };
  const projectManifest: Manifest = {
    jawfish: {
      focus: { tool: "codex" },
      review: { tool: "codex" },
      ghost: { tool: "codex" },
    },
  };
  const globalManifest: Manifest = {
    jawfish: {
      handoff: { tool: "codex" },
      review: { tool: "codex" },
    },
  };

  return {
    agenticsRepoDir: join(homedir(), "agentics"),
    catalog,
    globalManifest,
    projectManifest,
  };
}
