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

type DirectoryDestinationSpec = Extract<DestinationSpec, { kind: "directory" }>;
type MarkdownFileDestinationSpec = Extract<DestinationSpec, { kind: "file" }>;
type ProviderRoot = (scope: InstallScope, paths: ToolPaths) => string;
type DestinationResolver = (
  name: string,
  type: AgenticType,
  scope: InstallScope,
  paths: ToolPaths,
) => DestinationSpec;

interface ToolAdapter {
  providerRoot: ProviderRoot;
  destination: DestinationResolver;
}

const adapters = {
  codex: directoryAdapter(codexRoot),
  "claude-code": directoryAdapter(claudeCodeRoot),
  hermes: directoryAdapter(hermesRoot),
  openclaw: {
    providerRoot: openclawRoot,
    destination: (name, type, scope, paths) => {
      if (type !== "skill") {
        throw new Error("OpenClaw supports only skill packages");
      }

      const root = openclawRoot(scope, paths);
      return directorySpec(join(skillRoot(root), name));
    },
  },
  opencode: {
    providerRoot: opencodeRoot,
    destination: (name, type, scope, paths) => {
      const root = opencodeRoot(scope, paths);
      switch (type) {
        case "agent":
          return markdownFileSpec(join(root, "agents", `${name}.md`));
        case "prompt":
          return markdownFileSpec(join(root, "commands", `${name}.md`));
        case "skill":
          return directorySpec(join(skillRoot(root), name));
      }
    },
  },
  pi: {
    providerRoot: piRoot,
    destination: (name, type, scope, paths) => {
      const root = piRoot(scope, paths);
      switch (type) {
        case "agent":
          return directorySpec(join(root, "extensions", name));
        case "prompt":
          return markdownFileSpec(join(root, "prompts", `${name}.md`));
        case "skill":
          return directorySpec(join(skillRoot(root), name));
      }
    },
  },
} satisfies Record<SupportedTool, ToolAdapter>;

export function assertSupportedTool(
  tool: string,
  source = "tool",
): asserts tool is SupportedTool {
  if (!isSupportedTool(tool)) {
    throw new Error(
      `Unsupported ${source}: ${tool}. Supported tools: ${supportedTools.join(", ")}`,
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

export function sourceProviderSkillRoot(
  tool: string,
  scope: InstallScope,
  paths: ToolPaths,
): string {
  assertSupportedTool(tool);
  return skillRoot(adapters[tool].providerRoot(scope, paths));
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

function directoryAdapter(providerRoot: ProviderRoot): ToolAdapter {
  return {
    providerRoot,
    destination: directoryDestination(providerRoot),
  };
}

function directoryDestination(providerRoot: ProviderRoot): DestinationResolver {
  return (name, type, scope, paths) =>
    directorySpec(join(providerRoot(scope, paths), typeFolder(type), name));
}

function directorySpec(path: string): DirectoryDestinationSpec {
  return { kind: "directory", path };
}

function markdownFileSpec(path: string): MarkdownFileDestinationSpec {
  return { extension: ".md", kind: "file", path };
}

function skillRoot(providerRoot: string): string {
  return join(providerRoot, typeFolder("skill"));
}

function codexRoot(scope: InstallScope, paths: ToolPaths): string {
  return scope === "project" ? join(paths.projectDir, ".codex") : paths.codexHome;
}

function claudeCodeRoot(scope: InstallScope, paths: ToolPaths): string {
  return join(scopeRoot(scope, paths), ".claude");
}

function hermesRoot(scope: InstallScope, paths: ToolPaths): string {
  return join(scopeRoot(scope, paths), ".hermes");
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
