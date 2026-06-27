import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bulkUpdateResult,
  formatUpdateDiagnostics,
  formatUpdateResult,
  updateFailure,
  updateResultExitCode,
  updatedPackageResult,
} from "../src/update-result.ts";

test("formats update result summaries and diagnostics", () => {
  const result = bulkUpdateResult({
    failed: [
      updateFailure(
        "plan",
        new Error("Package has dirty local changes: plan\n  prompts/plan/plan.md"),
      ),
    ],
    skipped: ["scratch"],
    updated: ["focus"],
  });

  assert.equal(
    formatUpdateResult(result),
    "Updated: focus\nSkipped: scratch\nFailed: plan (Package has dirty local changes: plan)",
  );
  assert.equal(
    formatUpdateDiagnostics(result),
    "Failed to update plan:\nPackage has dirty local changes: plan\n  prompts/plan/plan.md",
  );
  assert.equal(updateResultExitCode(result), 1);
  assert.equal(
    formatUpdateResult(updatedPackageResult("focus")),
    "Updated focus",
  );
});
