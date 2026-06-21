#!/usr/bin/env -S node --experimental-strip-types
import { cancel, isCancel, select } from "@clack/prompts";

const version = "0.1.0";
const commands = ["add", "install", "update", "remove"] as const;

type CommandName = (typeof commands)[number];

interface CommandSpec {
  description: string;
  usage: string;
  options: string[];
}

const commandSpecs: Record<CommandName, CommandSpec> = {
  add: {
    description: "Install an agentic from the library, or import a URL/local path later.",
    usage: "agentics add [options] <name|source>",
    options: [
      "-g, --global    Install globally",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
  },
  install: {
    description: "Materialize manifest agentics into tool-native directories later.",
    usage: "agentics install [options]",
    options: ["-g, --global    Install global manifest", "-h, --help      Show help"],
  },
  update: {
    description: "Refresh one or all upstream-backed agentics later.",
    usage: "agentics update [options] [name]",
    options: [
      "-F, --force     Replace dirty package contents",
      "-h, --help      Show help",
    ],
  },
  remove: {
    description: "Remove installed managed agentics later.",
    usage: "agentics remove [options] <name>",
    options: ["-g, --global    Remove global install", "-h, --help      Show help"],
  },
};

export async function promptForTool(allowedTools: string[]): Promise<string> {
  const selected = await select({
    message: "Select default tool",
    options: allowedTools.map((tool) => ({ label: tool, value: tool })),
  });

  if (isCancel(selected)) {
    cancel("No tool selected");
    process.exitCode = 1;
    return "";
  }

  return selected;
}

export function run(argv: string[]): number {
  const [command, ...args] = argv;

  if (command === undefined || isHelp(command)) {
    printRootHelp();
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }

  if (isCommandName(command)) {
    if (args.some(isHelp)) {
      printCommandHelp(command);
      return 0;
    }

    printCommandStub(command);
    return 0;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run agentics --help for usage.");
  return 1;
}

function printRootHelp(): void {
  console.log(`agentics ${version}

Usage: agentics <command> [options]

Commands:
  add       Install or import an agentic
  install   Materialize manifest agentics
  update    Update upstream-backed agentics
  remove    Remove installed agentics

Options:
  -h, --help      Show help
  -v, --version   Show version`);
}

function printCommandHelp(command: CommandName): void {
  const spec = commandSpecs[command];

  console.log(`${spec.description}

Usage: ${spec.usage}

Options:
${spec.options.map((option) => `  ${option}`).join("\n")}`);
}

function printCommandStub(command: CommandName): void {
  printCommandHelp(command);
  console.log("");
  console.log(`agentics ${command} behavior will be implemented in a later slice.`);
}

function isHelp(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isCommandName(value: string): value is CommandName {
  return commands.includes(value as CommandName);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
