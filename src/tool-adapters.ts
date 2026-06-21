import { join } from "node:path";

export const supportedTools = ["codex", "claude-code", "hermes"] as const;

export type AgenticType = "skill" | "agent" | "prompt";
export type InstallScope = "project" | "global";

export interface ToolPaths {
  codexHome: string;
  homeDir: string;
  projectDir: string;
}

interface ToolAdapter {
  destinationPath: (
    name: string,
    type: AgenticType,
    scope: InstallScope,
    paths: ToolPaths,
  ) => string;
}

const adapters = {
  codex: {
    destinationPath: (name, type, scope, paths) =>
      join(codexRoot(scope, paths), typeFolder(type), name),
  },
  "claude-code": {
    destinationPath: (name, type, scope, paths) =>
      join(scopeRoot(scope, paths), ".claude", typeFolder(type), name),
  },
  hermes: {
    destinationPath: (name, type, scope, paths) =>
      join(scopeRoot(scope, paths), ".hermes", typeFolder(type), name),
  },
} satisfies Record<string, ToolAdapter>;

export function assertSupportedTool(tool: string): void {
  if (!Object.hasOwn(adapters, tool)) {
    throw new Error(
      `Unsupported tool: ${tool}. Supported tools: ${supportedTools.join(", ")}`,
    );
  }
}

export function destinationPath(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
  paths: ToolPaths,
): string {
  assertSupportedTool(tool);
  return adapters[tool as keyof typeof adapters].destinationPath(
    name,
    type,
    scope,
    paths,
  );
}

export function typeFolder(type: AgenticType): string {
  switch (type) {
    case "agent":
      return "agents";
    case "prompt":
      return "prompts";
    case "skill":
      return "skills";
  }
}

function scopeRoot(scope: InstallScope, paths: ToolPaths): string {
  return scope === "project" ? paths.projectDir : paths.homeDir;
}

function codexRoot(scope: InstallScope, paths: ToolPaths): string {
  return scope === "project" ? join(paths.projectDir, ".codex") : paths.codexHome;
}
