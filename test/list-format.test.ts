import { test } from "node:test";
import assert from "node:assert/strict";
import { formatListRawJson, formatListTable } from "../src/list-format.ts";
import { type ListResult } from "../src/list-query.ts";

test("formats list results as table and raw JSON", () => {
  const result: ListResult = {
    entries: [
      {
        description: "Focus workflow",
        installed: "project",
        name: "focus",
        path: "~/agentics/skills/focus",
        type: "skill",
      },
      {
        description: "Review changes",
        installed: "both",
        name: "review",
        path: "~/agentics/agents/review",
        type: "agent",
      },
    ],
  };

  assert.equal(
    formatListTable(result),
    [
      "┌────────┬───────┬───────────┬────────────────┐",
      "│ name   │ type  │ installed │ description    │",
      "├────────┼───────┼───────────┼────────────────┤",
      "│ focus  │ skill │ project   │ Focus workflow │",
      "│ review │ agent │ both      │ Review changes │",
      "└────────┴───────┴───────────┴────────────────┘",
    ].join("\n"),
  );
  assert.deepEqual(JSON.parse(formatListRawJson(result)), result.entries);
});

test("formats an empty list result as a header-only table", () => {
  assert.equal(
    formatListTable({ entries: [] }),
    [
      "┌──────┬──────┬───────────┬─────────────┐",
      "│ name │ type │ installed │ description │",
      "├──────┼──────┼───────────┼─────────────┤",
      "└──────┴──────┴───────────┴─────────────┘",
    ].join("\n"),
  );
});
