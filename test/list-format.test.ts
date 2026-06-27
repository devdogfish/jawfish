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

  assert.match(
    formatListTable(result),
    /│ focus\s+│ skill\s+│ project\s+│ Focus workflow/,
  );
  assert.deepEqual(JSON.parse(formatListRawJson(result)), result.entries);
});
