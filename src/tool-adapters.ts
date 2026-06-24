import { join } from "node:path";

export const supportedTools = [
  "codex",
  "claude-code",
  "hermes",
  "openclaw",
  "opencode",
  "pi",
] as const;

export type SupportedTool = (typeof supportedTools)[number];
export type AgenticType = "skill" | "agent" | "prompt";
export type InstallScope = "project" | "global";

export interface ToolPaths {
  codexHome: string;
  homeDir: string;
  opencodeConfigDir: string;
  piAgentDir: string;
  projectDir: string;
}

export type DestinationSpec =
  | { kind: "directory"; path: string }
  | { extension: ".md"; kind: "file"; path: string };

interface ToolAdapter {
  destination: (
    name: string,
    type: AgenticType,
    scope: InstallScope,
    paths: ToolPaths,
  ) => DestinationSpec;
}

const adapters = {
  codex: {
    destination: (name, type, scope, paths) => ({
      kind: "directory",
      path: join(codexRoot(scope, paths), typeFolder(type), name),
    }),
  },
  "claude-code": {
    destination: (name, type, scope, paths) => ({
      kind: "directory",
      path: join(scopeRoot(scope, paths), ".claude", typeFolder(type), name),
    }),
  },
  hermes: {
    destination: (name, type, scope, paths) => ({
      kind: "directory",
      path: join(scopeRoot(scope, paths), ".hermes", typeFolder(type), name),
    }),
  },
  openclaw: {
    destination: (name, type, scope, paths) => {
      if (type !== "skill") {
        throw new Error("OpenClaw supports only skill packages");
      }

      return {
        kind: "directory",
        path: join(openclawRoot(scope, paths), "skills", name),
      };
    },
  },
  opencode: {
    destination: (name, type, scope, paths) => {
      const root = opencodeRoot(scope, paths);
      switch (type) {
        case "agent":
          return {
            extension: ".md",
            kind: "file",
            path: join(root, "agents", `${name}.md`),
          };
        case "prompt":
          return {
            extension: ".md",
            kind: "file",
            path: join(root, "commands", `${name}.md`),
          };
        case "skill":
          return {
            kind: "directory",
            path: join(root, "skills", name),
          };
      }
    },
  },
  pi: {
    destination: (name, type, scope, paths) => {
      const root = piRoot(scope, paths);
      switch (type) {
        case "agent":
          return {
            kind: "directory",
            path: join(root, "extensions", name),
          };
        case "prompt":
          return {
            extension: ".md",
            kind: "file",
            path: join(root, "prompts", `${name}.md`),
          };
        case "skill":
          return {
            kind: "directory",
            path: join(root, "skills", name),
          };
      }
    },
  },
} satisfies Record<SupportedTool, ToolAdapter>;

export function assertSupportedTool(tool: string): asserts tool is SupportedTool {
  if (!isSupportedTool(tool)) {
    throw new Error(
      `Unsupported tool: ${tool}. Supported tools: ${supportedTools.join(", ")}`,
    );
  }
}

function isSupportedTool(tool: string): tool is SupportedTool {
  return Object.hasOwn(adapters, tool);
}

export function destinationPath(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
  paths: ToolPaths,
): string {
  return destinationSpec(name, type, scope, tool, paths).path;
}

export function destinationSpec(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
  paths: ToolPaths,
): DestinationSpec {
  assertSupportedTool(tool);
  return adapters[tool].destination(name, type, scope, paths);
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

function openclawRoot(scope: InstallScope, paths: ToolPaths): string {
  return scope === "project"
    ? paths.projectDir
    : join(paths.homeDir, ".openclaw");
}

function opencodeRoot(scope: InstallScope, paths: ToolPaths): string {
  return scope === "project"
    ? join(paths.projectDir, ".opencode")
    : paths.opencodeConfigDir;
}

function piRoot(scope: InstallScope, paths: ToolPaths): string {
  return scope === "project" ? join(paths.projectDir, ".pi") : paths.piAgentDir;
}
