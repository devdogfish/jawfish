import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  destinationSpec,
  sourceProviderSkillRoot,
  supportedTools,
  type AgenticType,
  type InstallScope,
  type ToolPaths,
} from "../src/tool-adapters.ts";

const root = "/jawfish-test";
const paths: ToolPaths = {
  codexHome: join(root, "codex-home"),
  homeDir: join(root, "home"),
  opencodeConfigDir: join(root, "opencode-config"),
  piAgentDir: join(root, "pi-agent"),
  projectDir: join(root, "project"),
};
const types = ["skill", "agent", "prompt"] as const;
const scopes = ["project", "global"] as const;

test("calculates supported tool destinations and source skill roots", () => {
  for (const tool of supportedTools) {
    for (const scope of scopes) {
      assert.equal(
        sourceProviderSkillRoot(tool, scope, paths),
        expectedSkillRoot(tool, scope),
        `${tool} ${scope} source root`,
      );

      for (const type of types) {
        if (tool === "openclaw" && type !== "skill") {
          assert.throws(
            () => destinationSpec("focus", type, scope, tool, paths),
            /OpenClaw supports only skill packages/,
            `${tool} ${scope} ${type}`,
          );
          continue;
        }

        assert.deepEqual(
          destinationSpec("focus", type, scope, tool, paths),
          expectedDestination(tool, scope, type),
          `${tool} ${scope} ${type}`,
        );
      }
    }
  }
});

function expectedDestination(
  tool: (typeof supportedTools)[number],
  scope: InstallScope,
  type: AgenticType,
) {
  const root = expectedToolRoot(tool, scope);
  switch (tool) {
    case "opencode":
      if (type === "agent") {
        return { extension: ".md", kind: "file", path: join(root, "agents", "focus.md") };
      }
      if (type === "prompt") {
        return { extension: ".md", kind: "file", path: join(root, "commands", "focus.md") };
      }
      return { kind: "directory", path: join(root, "skills", "focus") };
    case "pi":
      if (type === "agent") {
        return { kind: "directory", path: join(root, "extensions", "focus") };
      }
      if (type === "prompt") {
        return { extension: ".md", kind: "file", path: join(root, "prompts", "focus.md") };
      }
      return { kind: "directory", path: join(root, "skills", "focus") };
    default:
      return { kind: "directory", path: join(root, typeFolder(type), "focus") };
  }
}

function expectedSkillRoot(
  tool: (typeof supportedTools)[number],
  scope: InstallScope,
): string {
  return join(expectedToolRoot(tool, scope), "skills");
}

function expectedToolRoot(
  tool: (typeof supportedTools)[number],
  scope: InstallScope,
): string {
  const scopeRoot = scope === "project" ? paths.projectDir : paths.homeDir;
  switch (tool) {
    case "codex":
      return scope === "project" ? join(paths.projectDir, ".codex") : paths.codexHome;
    case "claude-code":
      return join(scopeRoot, ".claude");
    case "hermes":
      return join(scopeRoot, ".hermes");
    case "openclaw":
      return scope === "project" ? paths.projectDir : join(paths.homeDir, ".openclaw");
    case "opencode":
      return scope === "project"
        ? join(paths.projectDir, ".opencode")
        : paths.opencodeConfigDir;
    case "pi":
      return scope === "project" ? join(paths.projectDir, ".pi") : paths.piAgentDir;
  }
}

function typeFolder(type: AgenticType): string {
  switch (type) {
    case "agent":
      return "agents";
    case "prompt":
      return "prompts";
    case "skill":
      return "skills";
  }
}
