import { agenticTypes, isAgenticType } from "./catalog.ts";
import { type AgenticType } from "./tool-adapters.ts";

interface CommandSpec {
  description: string;
  handler: CommandHandler | ((args: CommandArgs) => CommandHandler);
  help: readonly string[];
  options: readonly CommandOptionName[];
  positionals: {
    min: number;
    max: number;
  };
  summary: string;
  usage: string;
}

export interface CommandArgs {
  force: boolean;
  global: boolean;
  help: boolean;
  installed?: InstalledFilter;
  name?: string;
  positionals: string[];
  raw: boolean;
  type?: AgenticType;
  yes: boolean;
}

export type CommandHandler =
  | "add"
  | "init"
  | "install"
  | "import-skills"
  | "list"
  | "remove"
  | "update"
  | "upgrade";

export type CommandRequest =
  | { kind: "command-help"; command: CommandName }
  | {
      args: CommandArgs;
      command: CommandName;
      handler: CommandHandler;
      kind: "dispatch";
    }
  | { kind: "root-help" }
  | { kind: "version" };

const optionSpecs = {
  force: {
    flags: ["-F", "--force"],
    takesValue: false,
  },
  global: {
    flags: ["-g", "--global"],
    takesValue: false,
  },
  help: {
    flags: ["-h", "--help"],
    takesValue: false,
  },
  installed: {
    flags: ["--installed"],
    takesValue: true,
  },
  name: {
    flags: ["--name"],
    takesValue: true,
  },
  raw: {
    flags: ["--raw"],
    takesValue: false,
  },
  type: {
    flags: ["--type"],
    takesValue: true,
  },
  yes: {
    flags: ["-y", "--yes"],
    takesValue: false,
  },
} as const;

type CommandOptionName = keyof typeof optionSpecs;
type ValueOptionName = {
  [Option in CommandOptionName]: (typeof optionSpecs)[Option] extends {
    takesValue: true;
  }
    ? Option
    : never;
}[CommandOptionName];
type BooleanOptionName = Exclude<CommandOptionName, ValueOptionName>;

type ParsedCommandArgs = Omit<CommandArgs, "installed" | "type"> & {
  installed?: string;
  type?: string;
};

const installHelp = [
  "-g, --global    Install global manifest",
  "-y, --yes       For repo roots, select all non-conflicting skills",
  "--name <name>   Override imported package name",
  "-h, --help      Show help",
] as const;

const installOptions = ["global", "yes", "name", "help"] as const;

const commandSpecs = {
  add: {
    description:
      "Install an agentic from the agentics repo, or import a URL/local path.",
    handler: "add",
    help: [
      "-g, --global    Install globally",
      "-y, --yes       For repo roots, select all non-conflicting skills",
      "--name <name>   Override imported package name",
      "-h, --help      Show help",
    ],
    summary: "Install or import an agentic",
    usage: "jawfish add [options] <name|source>",
    options: ["global", "yes", "name", "help"],
    positionals: { min: 1, max: 1 },
  },
  init: {
    description: "Create or edit jawfish machine/project setup.",
    handler: "init",
    help: [
      "-y, --yes       Use noninteractive defaults",
      "-h, --help      Show help",
    ],
    summary: "Create or edit setup",
    usage: "jawfish init [options]",
    options: ["yes", "help"],
    positionals: { min: 0, max: 0 },
  },
  install: {
    description:
      "Install an agentic when a name/source is provided, otherwise materialize manifest jawfish.",
    handler: installHandler,
    help: installHelp,
    summary: "Install an agentic or manifest",
    usage: "jawfish install [options] [name|source]",
    options: installOptions,
    positionals: { min: 0, max: 1 },
  },
  i: {
    description:
      "Alias for install: add a name/source, or materialize the manifest with no name/source.",
    handler: installHandler,
    help: installHelp,
    summary: "Alias for install",
    usage: "jawfish i [options] [name|source]",
    options: installOptions,
    positionals: { min: 0, max: 1 },
  },
  "import-skills": {
    description: "Import existing global skills from a supported tool.",
    handler: "import-skills",
    help: [
      "-y, --yes      Import without prompting",
      "-h, --help     Show help",
    ],
    summary: "Import global provider skills",
    usage: "jawfish import-skills [options] <provider>",
    options: ["yes", "help"],
    positionals: { min: 1, max: 1 },
  },
  list: {
    description: "List available jawfish in the agentics repo.",
    handler: "list",
    help: [
      "--type <type>           Filter by skill, agent, or prompt",
      "--installed <status>    Filter by project, global, both, none, or any",
      "--raw                   Print JSON",
      "-h, --help              Show help",
    ],
    summary: "List available jawfish",
    usage: "jawfish list [options]",
    options: ["type", "installed", "raw", "help"],
    positionals: { min: 0, max: 0 },
  },
  update: {
    description: "Refresh one or all upstream-backed jawfish.",
    handler: "update",
    help: [
      "-g, --global    Reinstall global manifest if already installed",
      "-F, --force     Replace dirty package contents",
      "-h, --help      Show help",
    ],
    summary: "Update upstream-backed jawfish",
    usage: "jawfish update [options] [name]",
    options: ["global", "force", "help"],
    positionals: { min: 0, max: 1 },
  },
  upgrade: {
    description: "Upgrade the jawfish CLI itself.",
    handler: "upgrade",
    help: ["-h, --help      Show help"],
    summary: "Upgrade jawfish itself",
    usage: "jawfish upgrade",
    options: ["help"],
    positionals: { min: 0, max: 0 },
  },
  remove: {
    description: "Remove installed managed jawfish.",
    handler: "remove",
    help: [
      "-g, --global    Remove global install",
      "-h, --help      Show help",
    ],
    summary: "Remove installed jawfish",
    usage: "jawfish remove [options] <name>",
    options: ["global", "help"],
    positionals: { min: 1, max: 1 },
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commandSpecs;

export const installedFilters = [
  "project",
  "global",
  "both",
  "none",
  "any",
] as const;
export type InstalledFilter = (typeof installedFilters)[number];

const commandNames = Object.keys(commandSpecs) as CommandName[];
const installedFilterSet = new Set<string>(installedFilters);
const optionByFlag = buildOptionByFlag();

export function parseCommand(argv: string[]): CommandRequest {
  const [command, ...args] = argv;

  if (command === undefined || isHelpFlag(command)) {
    return { kind: "root-help" };
  }

  if (command === "--version" || command === "-v") {
    return { kind: "version" };
  }

  if (!isCommandName(command)) {
    throw new Error(`Unknown command: ${command}\nRun jawfish --help for usage.`);
  }

  const parsed = parseCommandArgs(args, command);
  if (parsed.help) {
    return { kind: "command-help", command };
  }

  const commandArgs = validateCommandArgs(command, parsed);
  return {
    args: commandArgs,
    command,
    handler: commandHandler(command, commandArgs),
    kind: "dispatch",
  };
}

export function formatRootHelp(version: string): string {
  const commandWidth =
    Math.max(...commandNames.map((command) => command.length)) + 2;

  return `jawfish ${version}

Usage: jawfish <command> [options]

Commands:
${commandNames
  .map(
    (command) =>
      `  ${command.padEnd(commandWidth)}${commandSpecs[command].summary}`,
  )
  .join("\n")}

Options:
  -h, --help      Show help
  -v, --version   Show version`;
}

export function formatCommandHelp(command: CommandName): string {
  const spec = commandSpecs[command];

  return `${spec.description}

Usage: ${spec.usage}

Options:
${spec.help.map((option) => `  ${option}`).join("\n")}`;
}

export function isInstalledFilter(value: string): value is InstalledFilter {
  return installedFilterSet.has(value);
}

function parseCommandArgs(
  args: string[],
  command: CommandName,
): ParsedCommandArgs {
  const parsed = defaultCommandArgs();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const option = optionByFlag.get(arg);
    if (option !== undefined) {
      assertAllowedOption(command, option, arg);

      if (isValueOption(option)) {
        const value = args[index + 1];
        if (value === undefined) {
          throw new Error(missingOptionValueMessage(command, arg));
        }

        setValueOption(parsed, option, value);
        index += 1;
        continue;
      }

      setBooleanOption(parsed, option);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(optionErrorMessage(command, "Unknown option", arg));
    }

    parsed.positionals.push(arg);
  }

  return parsed;
}

function defaultCommandArgs(): ParsedCommandArgs {
  return {
    force: false,
    global: false,
    help: false,
    positionals: [],
    raw: false,
    yes: false,
  };
}

function validateCommandArgs(
  command: CommandName,
  args: ParsedCommandArgs,
): CommandArgs {
  const { max, min } = commandSpecs[command].positionals;
  if (args.positionals.length < min || args.positionals.length > max) {
    throw new Error(usageLine(command));
  }

  let type: AgenticType | undefined;
  if (args.type !== undefined) {
    if (!isAgenticType(args.type)) {
      throw new Error(
        `Unsupported type: ${args.type}. Supported types: ${agenticTypes.join(", ")}`,
      );
    }

    type = args.type;
  }

  let installed: InstalledFilter | undefined;
  if (args.installed !== undefined) {
    if (!isInstalledFilter(args.installed)) {
      throw new Error(
        `Unsupported installed filter: ${args.installed}. Supported filters: ${installedFilters.join(", ")}`,
      );
    }

    installed = args.installed;
  }

  return toCommandArgs(args, type, installed);
}

function toCommandArgs(
  args: ParsedCommandArgs,
  type: AgenticType | undefined,
  installed: InstalledFilter | undefined,
): CommandArgs {
  const commandArgs: CommandArgs = {
    force: args.force,
    global: args.global,
    help: args.help,
    positionals: args.positionals,
    raw: args.raw,
    yes: args.yes,
  };

  if (args.name !== undefined) {
    commandArgs.name = args.name;
  }

  if (type !== undefined) {
    commandArgs.type = type;
  }

  if (installed !== undefined) {
    commandArgs.installed = installed;
  }

  return commandArgs;
}

function assertAllowedOption(
  command: CommandName,
  option: CommandOptionName,
  flag: string,
): void {
  const options: readonly CommandOptionName[] = commandSpecs[command].options;
  if (!options.includes(option)) {
    throw new Error(optionErrorMessage(command, "Unsupported option", flag));
  }
}

function commandHandler(
  command: CommandName,
  args: CommandArgs,
): CommandHandler {
  const handler = commandSpecs[command].handler;
  return typeof handler === "function" ? handler(args) : handler;
}

function installHandler(args: CommandArgs): CommandHandler {
  return args.positionals.length > 0 ? "add" : "install";
}

function setBooleanOption(
  args: ParsedCommandArgs,
  option: BooleanOptionName,
): void {
  switch (option) {
    case "force":
      args.force = true;
      return;
    case "global":
      args.global = true;
      return;
    case "help":
      args.help = true;
      return;
    case "raw":
      args.raw = true;
      return;
    case "yes":
      args.yes = true;
      return;
  }
}

function setValueOption(
  args: ParsedCommandArgs,
  option: ValueOptionName,
  value: string,
): void {
  switch (option) {
    case "installed":
      args.installed = value;
      return;
    case "name":
      args.name = value;
      return;
    case "type":
      args.type = value;
      return;
  }
}

function isValueOption(option: CommandOptionName): option is ValueOptionName {
  return optionSpecs[option].takesValue;
}

function missingOptionValueMessage(
  command: CommandName,
  option: string,
): string {
  return `${option} requires a value\n${usageLine(command)}`;
}

function optionErrorMessage(
  command: CommandName,
  message: string,
  option: string,
): string {
  return `${message}: ${option}\n${usageLine(command)}`;
}

function usageLine(command: CommandName): string {
  return `Usage: ${commandSpecs[command].usage}`;
}

function buildOptionByFlag(): Map<string, CommandOptionName> {
  const entries: Array<[string, CommandOptionName]> = [];
  for (const option of Object.keys(optionSpecs) as CommandOptionName[]) {
    for (const flag of optionSpecs[option].flags) {
      entries.push([flag, option]);
    }
  }

  return new Map(entries);
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commandSpecs, value);
}
