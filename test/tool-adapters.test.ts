import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  destinationSpec,
  sourceProviderSkillRoot,
  supportedTools,
  type AgenticType,
  type DestinationSpec,
  type InstallScope,
  type SupportedTool,
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
const agenticTypes = ["skill", "agent", "prompt"] as const;
const installScopes = ["project", "global"] as const;

test("calculates supported tool destinations and source skill roots", () => {
  for (const tool of supportedTools) {
    for (const scope of installScopes) {
      assert.equal(
        sourceProviderSkillRoot(tool, scope, paths),
        expectedSkillRoot(tool, scope),
        `${tool} ${scope} source root`,
      );

      for (const type of agenticTypes) {
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
  tool: SupportedTool,
  scope: InstallScope,
  type: AgenticType,
): DestinationSpec {
  const root = expectedToolRoot(tool, scope);
  switch (tool) {
    case "opencode":
      if (type === "agent") {
        return expectedMarkdownFile(join(root, "agents", "focus.md"));
      }
      if (type === "prompt") {
        return expectedMarkdownFile(join(root, "commands", "focus.md"));
      }
      return expectedDirectory(join(root, "skills", "focus"));
    case "pi":
      if (type === "agent") {
        return expectedDirectory(join(root, "extensions", "focus"));
      }
      if (type === "prompt") {
        return expectedMarkdownFile(join(root, "prompts", "focus.md"));
      }
      return expectedDirectory(join(root, "skills", "focus"));
    default:
      return expectedDirectory(join(root, typeFolder(type), "focus"));
  }
}

function expectedSkillRoot(
  tool: SupportedTool,
  scope: InstallScope,
): string {
  return join(expectedToolRoot(tool, scope), "skills");
}

function expectedToolRoot(
  tool: SupportedTool,
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

function expectedDirectory(path: string): DestinationSpec {
  return { kind: "directory", path };
}

function expectedMarkdownFile(path: string): DestinationSpec {
  return { extension: ".md", kind: "file", path };
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
