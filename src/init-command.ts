import { cancel, isCancel, multiselect, select, text } from "@clack/prompts";
import { join } from "node:path";
import {
  agenticsRepoOriginRemote,
  assertAgenticsRepoPathSupported,
  createAgenticsRepoSession,
  inspectionAgenticsRepoDir,
  isBareAgenticsRepo,
  looksLikeAgenticsRepoRemote,
  prepareAgenticsRepoSelection,
  type AgenticsRepoInspection,
  type AgenticsRepoSelection,
  type AgenticsRepoSession,
} from "./agentics-repo.ts";
import { type Catalog } from "./catalog.ts";
import {
  assertSupportedConfiguredTool,
  configPath,
  defaultSupportedTools,
  existingConfigPath,
  jawfishHome,
  loadConfig,
  managedAgenticsRepoPath,
  manifestPath,
  saveConfig,
  type JawfishConfig,
} from "./config.ts";
import { exists } from "./files.ts";
import {
  installManifestEntry,
  readManifest,
  writeJson,
  type Manifest,
} from "./install.ts";
import {
  applySelectedSkillImports,
  discoverImportableSkills,
  importProviderSkillsToSession,
  type ImportableSkillCandidate,
} from "./provider-skill-import.ts";

interface InitCommandArgs {
  force: boolean;
  global: boolean;
  name?: string;
  positionals: string[];
  raw: boolean;
  type?: string;
  yes: boolean;
}

type AgenticsRepoMode = "link" | "local";
type ExistingMachineInitAction = "project" | "reinitialize";
type MachineReinitializeAction =
  | "agentics"
  | "agentics-repo"
  | "default-tool"
  | "done"
  | "global-starters"
  | "import-skills";

export interface InitCommandPrompts {
  inputAgenticsRepo: () => Promise<string>;
  inputAgenticsRepoLocalPath?: (defaultPath: string) => Promise<string>;
  inputAgenticsRepoRemote?: () => Promise<string | undefined>;
  selectExistingMachineInitAction?: (
    hasProjectManifest: boolean,
  ) => Promise<ExistingMachineInitAction>;
  selectAgenticsRepoMode: () => Promise<AgenticsRepoMode>;
  selectDefaultTool: (supportedTools: readonly string[]) => Promise<string>;
  selectGlobalStarterAgentics?: (
    inspection: AgenticsRepoInspection,
    manifest: Manifest,
  ) => Promise<string[]>;
  selectImportSkills?: (
    candidates: ImportableSkillCandidate[],
  ) => Promise<string[]>;
  selectImportProviders?: (supportedTools: readonly string[]) => Promise<string[]>;
  selectMachineReinitializeAction?: (
    config: JawfishConfig,
  ) => Promise<MachineReinitializeAction>;
  selectProjectAgentics?: (
    inspection: AgenticsRepoInspection,
    manifest: Manifest,
  ) => Promise<string[]>;
}

interface AgenticsSelectionPromptOptions {
  cancelMessage: string;
  message: string;
}

interface InitCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts?: InitCommandPrompts;
}

interface InitContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompts: InitCommandPrompts;
}

export async function initCommand(
  args: InitCommandArgs,
  options: InitCommandOptions = {},
): Promise<number> {
  const context = initContext(options);

  if (
    args.force ||
    args.global ||
    args.name !== undefined ||
    args.positionals.length > 0 ||
    args.raw ||
    args.type !== undefined
  ) {
    console.error("Usage: jawfish init [options]");
    return 1;
  }

  const configFile = await existingConfigPath(context.env);
  if (configFile === undefined) {
    const config = args.yes || hasCompleteMachineSetupEnv(context)
      ? await createMachineSetup(context)
      : await createInteractiveMachineSetup(context);
    console.log(`Initialized jawfish at ${configPath(jawfishHome(context.env))}`);
    if (config.agenticsRepo !== undefined && config.agenticsRepo !== "") {
      await printAgenticsRepoLocation(config.agenticsRepo, context);
    }
    if (args.yes) {
      await printAgenticsRepoInspection(config.agenticsRepo, context);
      return 0;
    }

    await runProjectSetup(config, context);
    return 0;
  }

  const config = await validateMachineSetup(context);
  if (args.yes) {
    await ensureProjectManifest(context);
    console.log(
      `Initialized project at ${manifestPath("project", context.env, context.cwd)}`,
    );
    await printAgenticsRepoInspection(config.agenticsRepo, context);
    return 0;
  }

  await runExistingMachineInit(config, context);
  return 0;
}

function hasCompleteMachineSetupEnv(context: InitContext): boolean {
  return (
    context.env.JAWFISH_AGENTICS_REPO !== undefined &&
    context.env.JAWFISH_DEFAULT_TOOL !== undefined
  );
}

function initContext(options: InitCommandOptions): InitContext {
  return {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    prompts: options.prompts ?? defaultInitPrompts,
  };
}

const defaultInitPrompts: InitCommandPrompts = {
  inputAgenticsRepo: promptForAgenticsRepo,
  inputAgenticsRepoLocalPath: promptForAgenticsRepoLocalPath,
  inputAgenticsRepoRemote: promptForAgenticsRepoRemote,
  selectExistingMachineInitAction: promptForExistingMachineInitAction,
  selectAgenticsRepoMode: promptForAgenticsRepoMode,
  selectDefaultTool: promptForDefaultTool,
  selectGlobalStarterAgentics: promptForGlobalStarterAgentics,
  selectImportSkills: promptForImportSkills,
  selectImportProviders: promptForImportProviders,
  selectMachineReinitializeAction: promptForMachineReinitializeAction,
};

async function createMachineSetup(context: InitContext): Promise<JawfishConfig> {
  const defaultTool = context.env.JAWFISH_DEFAULT_TOOL ?? firstSupportedTool();
  assertSupportedConfiguredTool(defaultTool, "JAWFISH_DEFAULT_TOOL");

  const selection = await noninteractiveAgenticsRepoSelection(context);
  const config: JawfishConfig = {
    agenticsRepo: selection.localPath,
    defaultTool,
  };

  await prepareAgenticsRepo(selection, context);
  await ensureGlobalManifest(context);
  await saveConfig(config, { env: context.env });
  return config;
}

async function createInteractiveMachineSetup(
  context: InitContext,
): Promise<JawfishConfig> {
  const defaultTool = await context.prompts.selectDefaultTool(defaultSupportedTools);
  assertSupportedConfiguredTool(defaultTool, "selected default tool");

  const repoMode = await context.prompts.selectAgenticsRepoMode();
  const selection = await resolveAgenticsRepoSelection(repoMode, context);

  const config: JawfishConfig = {
    agenticsRepo: selection.localPath,
    defaultTool,
  };
  await prepareAgenticsRepo(selection, context);
  await ensureGlobalManifest(context);
  await runMachineStarterSetup(config, context);
  await saveConfig(config, { env: context.env });
  return config;
}

function firstSupportedTool(): string {
  const [tool] = defaultSupportedTools;
  if (tool === undefined) {
    throw new Error("No supported tools configured");
  }

  return tool;
}

async function resolveAgenticsRepoSelection(
  mode: AgenticsRepoMode,
  context: InitContext,
): Promise<AgenticsRepoSelection> {
  const defaultLocalPath = managedAgenticsRepoPath(context.env);
  if (mode === "local") {
    return {
      createIfMissing: true,
      localPath: await inputAgenticsRepoLocalPath(context, defaultLocalPath),
      remoteSource: await inputAgenticsRepoRemote(context),
    };
  }

  const selected = await context.prompts.inputAgenticsRepo();
  if (
    looksLikeAgenticsRepoRemote(selected) ||
    (await isBareAgenticsRepo(selected))
  ) {
    return {
      createIfMissing: true,
      localPath: await inputAgenticsRepoLocalPath(context, defaultLocalPath),
      remoteSource: selected,
    };
  }

  return {
    createIfMissing: false,
    localPath: selected,
    remoteSource: await inputAgenticsRepoRemote(context),
  };
}

async function noninteractiveAgenticsRepoSelection(
  context: InitContext,
): Promise<AgenticsRepoSelection> {
  const configured = context.env.JAWFISH_AGENTICS_REPO;
  if (configured === undefined || configured === "") {
    return {
      createIfMissing: true,
      localPath: managedAgenticsRepoPath(context.env),
    };
  }

  if (
    looksLikeAgenticsRepoRemote(configured) ||
    (await isBareAgenticsRepo(configured))
  ) {
    return {
      createIfMissing: true,
      localPath: managedAgenticsRepoPath(context.env),
      remoteSource: configured,
    };
  }

  return { createIfMissing: true, localPath: configured };
}

async function inputAgenticsRepoLocalPath(
  context: InitContext,
  defaultPath: string,
): Promise<string> {
  const prompt = context.prompts.inputAgenticsRepoLocalPath;
  if (prompt === undefined) {
    return defaultPath;
  }

  const selected = await prompt(defaultPath);
  return selected.trim() === "" ? defaultPath : selected.trim();
}

async function inputAgenticsRepoRemote(
  context: InitContext,
): Promise<string | undefined> {
  const prompt = context.prompts.inputAgenticsRepoRemote;
  if (prompt === undefined) {
    return undefined;
  }

  const selected = await prompt();
  if (selected === undefined || selected.trim() === "") {
    return undefined;
  }

  return selected.trim();
}

async function prepareAgenticsRepo(
  selection: AgenticsRepoSelection,
  context: InitContext,
): Promise<void> {
  await prepareAgenticsRepoSelection(selection, {
    cwd: context.cwd,
    env: context.env,
  });
}

async function ensureGlobalManifest(context: InitContext): Promise<void> {
  await ensureManifest(manifestPath("global", context.env, context.cwd));
}

async function ensureProjectManifest(context: InitContext): Promise<void> {
  await ensureManifest(manifestPath("project", context.env, context.cwd));
}

async function validateMachineSetup(context: InitContext): Promise<JawfishConfig> {
  const config = await loadConfig({
    env: context.env,
    promptForMissingDefaultTool: false,
  });
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    return config;
  }

  assertAgenticsRepoPathSupported(config.agenticsRepo, {
    cwd: context.cwd,
    env: context.env,
  });
  return config;
}

async function ensureManifest(path: string): Promise<void> {
  if (await exists(path)) {
    return;
  }

  await writeJson(path, { jawfish: {} });
}

async function runExistingMachineInit(
  config: JawfishConfig,
  context: InitContext,
): Promise<void> {
  const hasProjectManifest = await exists(
    manifestPath("project", context.env, context.cwd),
  );
  const action = await selectExistingMachineInitAction(
    context,
    hasProjectManifest,
  );

  if (action === "project") {
    await runProjectSetup(config, context);
    return;
  }

  await runMachineReinitialize(config, context);
}

async function selectExistingMachineInitAction(
  context: InitContext,
  hasProjectManifest: boolean,
): Promise<ExistingMachineInitAction> {
  const prompt =
    context.prompts.selectExistingMachineInitAction ??
    promptForExistingMachineInitAction;
  return await prompt(hasProjectManifest);
}

async function runMachineReinitialize(
  initialConfig: JawfishConfig,
  context: InitContext,
): Promise<void> {
  let config = { ...initialConfig };

  await ensureGlobalManifest(context);
  while (true) {
    await printMachineConfig(config, context);
    const action = await selectMachineReinitializeAction(config, context);

    switch (action) {
      case "done":
        return;
      case "default-tool":
        config = await reinitializeDefaultTool(config, context);
        break;
      case "agentics-repo":
        config = await reinitializeAgenticsRepo(config, context);
        break;
      case "agentics":
        await runImportAndStarterEdit(config, context);
        break;
      case "global-starters":
        await runImportAndStarterEdit(config, context);
        break;
      case "import-skills":
        await runImportAndStarterEdit(config, context);
        break;
    }
  }
}

async function selectMachineReinitializeAction(
  config: JawfishConfig,
  context: InitContext,
): Promise<MachineReinitializeAction> {
  const prompt =
    context.prompts.selectMachineReinitializeAction ??
    promptForMachineReinitializeAction;
  return await prompt(config);
}

async function printMachineConfig(
  config: JawfishConfig,
  context: InitContext,
): Promise<void> {
  console.log("Current machine config");
  console.log(`Default tool: ${config.defaultTool ?? "missing"}`);
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    console.log("Agentics repo local: missing");
  } else {
    await printAgenticsRepoLocation(config.agenticsRepo, context);
  }
  console.log(`Config: ${configPath(jawfishHome(context.env))}`);
}

async function reinitializeDefaultTool(
  config: JawfishConfig,
  context: InitContext,
): Promise<JawfishConfig> {
  const defaultTool = await context.prompts.selectDefaultTool(defaultSupportedTools);
  assertSupportedConfiguredTool(defaultTool, "selected default tool");

  const nextConfig = { ...config, defaultTool };
  await saveConfig(nextConfig, { env: context.env });
  console.log(`Updated default tool: ${defaultTool}`);
  return nextConfig;
}

async function reinitializeAgenticsRepo(
  config: JawfishConfig,
  context: InitContext,
): Promise<JawfishConfig> {
  const repoMode = await context.prompts.selectAgenticsRepoMode();
  const selection = await resolveAgenticsRepoSelection(repoMode, context);

  await prepareAgenticsRepo(selection, context);
  const nextConfig = { ...config, agenticsRepo: selection.localPath };
  await saveConfig(nextConfig, { env: context.env });
  console.log(`Updated agentics repo local: ${selection.localPath}`);
  if (selection.remoteSource !== undefined) {
    console.log(`Updated agentics repo remote: ${selection.remoteSource}`);
  }
  await printAgenticsRepoInspection(selection.localPath, context);
  return nextConfig;
}

async function runImportAndStarterEdit(
  config: JawfishConfig,
  context: InitContext,
): Promise<void> {
  const session = await configuredAgenticsRepoSession(config, context);
  await importSelectedSkills(session, context);
  const inspection = await session.inspect();

  printInspection(inspection);
  if (inspection.usable.length === 0) {
    console.log("No registered agentics are selectable. Add or import agentics first.");
    return;
  }

  await installSelectedGlobalStarters(
    config,
    session.dir,
    inspection,
    context,
  );
}

async function runMachineStarterSetup(
  config: JawfishConfig,
  context: InitContext,
): Promise<void> {
  const session = await configuredAgenticsRepoSession(config, context);
  let inspection = await session.inspect();

  printInspection(inspection);

  const shouldImportBeforeStarterSelection = inspection.usable.length === 0;
  if (shouldImportBeforeStarterSelection) {
    await importSelectedSkills(session, context);
    inspection = await session.inspect();
    if (inspection.usable.length > 0) {
      printInspection(inspection);
    }
  }

  if (inspection.usable.length > 0) {
    await installSelectedGlobalStarters(config, session.dir, inspection, context);
  }

  if (!shouldImportBeforeStarterSelection) {
    await importSelectedSkills(session, context);
  }
}

async function importSelectedSkills(
  session: AgenticsRepoSession,
  context: InitContext,
): Promise<void> {
  const pathOptions = { cwd: context.cwd, env: context.env };
  const catalog = await session.readCatalog();
  const discovery = await discoverImportableSkills(
    defaultSupportedTools,
    ["global", "project"],
    catalog,
    pathOptions,
  );

  if (discovery.candidates.length === 0) {
    console.log("No importable skills found");
    return;
  }

  if (context.prompts.selectImportSkills === undefined) {
    await importSelectedProviders(session, context);
    return;
  }

  const selectedIds = await context.prompts.selectImportSkills(
    discovery.candidates,
  );
  const candidatesById = new Map(
    discovery.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const selected = selectedIds.map((id) => {
    const candidate = candidatesById.get(id);
    if (candidate === undefined) {
      throw new Error(`Selected import skill is not available: ${id}`);
    }
    return candidate;
  });

  if (selected.length === 0) {
    console.log("No skills selected for import");
    return;
  }

  await applySelectedSkillImports(session.dir, catalog, selected, pathOptions);
  await session.writeCatalog(catalog);
  if (!(await session.pushChanges("import skills"))) {
    throw new Error("Import failed");
  }
  console.log(`Imported ${selected.length} skills`);
}

async function importSelectedProviders(
  session: AgenticsRepoSession,
  context: InitContext,
): Promise<void> {
  const prompt = context.prompts.selectImportProviders;
  if (prompt === undefined) {
    return;
  }

  const selectedProviderNames = await prompt(defaultSupportedTools);
  assertSelectedImportProvidersSupported(selectedProviderNames);

  const pathOptions = { cwd: context.cwd, env: context.env };
  for (const provider of selectedProviderNames) {
    const result = await importProviderSkillsToSession(
      session,
      provider,
      pathOptions,
    );
    if (result !== 0) {
      throw new Error(`Import failed for ${provider}`);
    }
  }
}

async function installSelectedGlobalStarters(
  config: JawfishConfig,
  agenticsRepoDir: string,
  inspection: AgenticsRepoInspection,
  context: InitContext,
): Promise<void> {
  const pathOptions = { cwd: context.cwd, env: context.env };
  const manifest = await readManifest("global", pathOptions);
  const selected = await selectGlobalStarterAgentics(context, inspection, manifest);
  if (selected.length === 0) {
    console.log("No global starter agentics selected");
    return;
  }

  assertSelectedAgenticsAvailable(selected, inspection);

  const tool = configuredDefaultTool(config, context);
  const catalog = catalogFromInspection(inspection);
  for (const name of selected) {
    await installManifestEntry(
      agenticsRepoDir,
      catalog,
      name,
      "global",
      tool,
      pathOptions,
    );
    console.log(`Installed ${name} globally`);
  }
}

async function selectGlobalStarterAgentics(
  context: InitContext,
  inspection: AgenticsRepoInspection,
  manifest: Manifest,
): Promise<string[]> {
  const prompt = context.prompts.selectGlobalStarterAgentics;
  if (prompt === undefined) {
    return [];
  }

  return await prompt(inspection, manifest);
}

async function runProjectSetup(
  config: JawfishConfig,
  context: InitContext,
): Promise<void> {
  const session = await configuredAgenticsRepoSession(config, context);
  const inspection = await session.inspect();
  const pathOptions = { cwd: context.cwd, env: context.env };
  const manifest = await readManifest("project", pathOptions);

  console.log(
    `Initialized project at ${manifestPath("project", context.env, context.cwd)}`,
  );
  printInspection(inspection);

  if (inspection.usable.length === 0) {
    await ensureProjectManifest(context);
    console.log("No registered agentics are selectable. Add or import agentics first.");
    return;
  }

  const selected = await selectProjectAgentics(context, inspection, manifest);
  if (selected.length === 0) {
    await ensureProjectManifest(context);
    console.log("No project agentics selected");
    return;
  }

  assertSelectedAgenticsAvailable(selected, inspection);

  const tool = configuredDefaultTool(config, context);
  const catalog = catalogFromInspection(inspection);
  for (const name of selected) {
    await installManifestEntry(
      session.dir,
      catalog,
      name,
      "project",
      tool,
      pathOptions,
    );
    console.log(`Installed ${name} to project`);
  }
}

async function selectProjectAgentics(
  context: InitContext,
  inspection: AgenticsRepoInspection,
  manifest: Manifest,
): Promise<string[]> {
  const prompt = context.prompts.selectProjectAgentics ?? promptForProjectAgentics;
  return await prompt(inspection, manifest);
}

function assertSelectedAgenticsAvailable(
  selectedNames: string[],
  inspection: AgenticsRepoInspection,
): void {
  const available = new Set(inspection.usableNames);
  const missing = selectedNames.filter((name) => !available.has(name));
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Selected agentic is not available: ${missing.join(", ")}. ` +
      `Available: ${formatNames(inspection.usableNames)}`,
  );
}

function assertSelectedImportProvidersSupported(
  selectedProviderNames: string[],
): void {
  for (const provider of selectedProviderNames) {
    assertSupportedConfiguredTool(provider, "selected import provider");
  }
}

async function promptForProjectAgentics(
  inspection: AgenticsRepoInspection,
  manifest: Manifest,
): Promise<string[]> {
  return promptForAgenticsSelection(inspection, manifest, {
    cancelMessage: "Project setup cancelled",
    message: "Select project agentics",
  });
}

async function promptForGlobalStarterAgentics(
  inspection: AgenticsRepoInspection,
  manifest: Manifest,
): Promise<string[]> {
  return promptForAgenticsSelection(inspection, manifest, {
    cancelMessage: "Starter setup cancelled",
    message: "Select global starter agentics",
  });
}

async function promptForAgenticsSelection(
  inspection: AgenticsRepoInspection,
  manifest: Manifest,
  options: AgenticsSelectionPromptOptions,
): Promise<string[]> {
  const selected = await multiselect({
    message: options.message,
    options: inspection.usable.map(({ entry, name }) => ({
      hint: entry.description,
      label: `${name} (${entry.type})`,
      value: name,
    })),
    initialValues: Object.keys(manifest.jawfish).filter((name) =>
      inspection.usableNames.includes(name),
    ),
    required: false,
  });

  if (isCancel(selected)) {
    cancel(options.cancelMessage);
    throw new Error(options.cancelMessage);
  }

  return selected;
}

async function promptForImportProviders(
  tools: readonly string[],
): Promise<string[]> {
  const selected = await multiselect({
    message: "Import existing global skills",
    options: tools.map((tool) => ({ label: tool, value: tool })),
    required: false,
  });

  if (isCancel(selected)) {
    cancel("Import cancelled");
    throw new Error("Import cancelled");
  }

  return selected;
}

async function promptForImportSkills(
  candidates: ImportableSkillCandidate[],
): Promise<string[]> {
  const selected = await multiselect({
    message: "Import existing skills",
    options: candidates.map((candidate) => ({
      hint: candidate.path,
      label: `${candidate.name} (${candidate.provider}, ${candidate.scope})`,
      value: candidate.id,
    })),
    required: false,
  });

  if (isCancel(selected)) {
    cancel("Import cancelled");
    throw new Error("Import cancelled");
  }

  return selected;
}

async function promptForExistingMachineInitAction(
  hasProjectManifest: boolean,
): Promise<ExistingMachineInitAction> {
  const selected = await select({
    message: "Choose init action",
    options: [
      {
        label: hasProjectManifest
          ? "Add/update project items"
          : "Set up this project",
        value: "project",
      },
      { label: "Reinitialize machine setup", value: "reinitialize" },
    ],
  });

  if (isCancel(selected)) {
    cancel("Init cancelled");
    throw new Error("Init cancelled");
  }

  return selected;
}

async function promptForMachineReinitializeAction(
  config: JawfishConfig,
): Promise<MachineReinitializeAction> {
  const selected = await select({
    message: "Edit machine setup",
    options: [
      {
        label: `Change default tool (${config.defaultTool ?? "missing"})`,
        value: "default-tool",
      },
      { label: "Configure agentics repository", value: "agentics-repo" },
      { label: "Add existing/global starter agentics", value: "agentics" },
      { label: "Done", value: "done" },
    ],
  });

  if (isCancel(selected)) {
    cancel("Machine reinitialize cancelled");
    throw new Error("Machine reinitialize cancelled");
  }

  return selected;
}

function catalogFromInspection(inspection: AgenticsRepoInspection): Catalog {
  return {
    jawfish: Object.fromEntries(
      inspection.usable.map(({ entry, name }) => [name, entry]),
    ),
  };
}

function configuredDefaultTool(config: JawfishConfig, context: InitContext): string {
  if (config.defaultTool === undefined || config.defaultTool === "") {
    throw new Error(`Missing defaultTool in ${configPath(jawfishHome(context.env))}`);
  }

  assertSupportedConfiguredTool(config.defaultTool, "config defaultTool");
  return config.defaultTool;
}

function configuredAgenticsRepo(
  config: JawfishConfig,
  context: InitContext,
): string {
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    throw new Error(`Missing agenticsRepo in ${configPath(jawfishHome(context.env))}`);
  }

  return config.agenticsRepo;
}

async function configuredAgenticsRepoDir(
  config: JawfishConfig,
  context: InitContext,
): Promise<string> {
  const agenticsRepo = configuredAgenticsRepo(config, context);
  return await inspectionAgenticsRepoDir(agenticsRepo, {
    cwd: context.cwd,
    env: context.env,
  });
}

async function configuredAgenticsRepoSession(
  config: JawfishConfig,
  context: InitContext,
): Promise<AgenticsRepoSession> {
  return createAgenticsRepoSession(
    await configuredAgenticsRepoDir(config, context),
  );
}

async function printAgenticsRepoInspection(
  agenticsRepo: string | undefined,
  context: InitContext,
): Promise<void> {
  if (agenticsRepo === undefined || agenticsRepo === "") {
    console.log("Agentics repo inspection");
    console.log("Catalog: none");
    console.log("Counts: 0 skills, 0 agents, 0 prompts");
    console.log("Usable: none");
    return;
  }

  const session = createAgenticsRepoSession(
    await inspectionAgenticsRepoDir(agenticsRepo, {
      cwd: context.cwd,
      env: context.env,
    }),
  );
  printInspection(await session.inspect());
}

async function printAgenticsRepoLocation(
  agenticsRepo: string,
  context: InitContext,
): Promise<void> {
  const agenticsRepoDir = await inspectionAgenticsRepoDir(agenticsRepo, {
    cwd: context.cwd,
    env: context.env,
  });
  console.log(`Agentics repo local: ${agenticsRepoDir}`);

  const remote = await agenticsRepoOriginRemote(agenticsRepoDir);
  if (remote !== undefined) {
    console.log(`Agentics repo remote: ${remote}`);
  }
}

function printInspection(inspection: AgenticsRepoInspection): void {
  console.log("Agentics repo inspection");
  console.log(`Catalog: ${inspection.catalogPath ?? "none"}`);
  console.log(
    `Counts: ${formatCount(inspection.counts.skill, "skill")}, ` +
      `${formatCount(inspection.counts.agent, "agent")}, ` +
      `${formatCount(inspection.counts.prompt, "prompt")}`,
  );
  console.log(`Usable: ${formatNames(inspection.usableNames)}`);

  if (
    inspection.usableNames.length === 0 &&
    inspection.broken.length === 0 &&
    inspection.skipped.length === 0
  ) {
    console.log("Repo is empty. Add or import agentics to make them selectable.");
  }

  for (const issue of inspection.broken) {
    console.log(`Broken: ${issue.target}: ${issue.reason}`);
  }
  for (const issue of inspection.skipped) {
    console.log(`Skipped: ${issue.target}: ${issue.reason}`);
  }
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatNames(names: string[]): string {
  if (names.length === 0) {
    return "none";
  }

  return names.join(", ");
}

async function promptForDefaultTool(tools: readonly string[]): Promise<string> {
  const selected = await select({
    message: "Select default tool",
    options: tools.map((tool) => ({ label: tool, value: tool })),
  });

  if (isCancel(selected)) {
    cancel("No tool selected");
    throw new Error("No tool selected");
  }

  return selected;
}

async function promptForAgenticsRepoMode(): Promise<AgenticsRepoMode> {
  const selected = await select({
    message: "Set up agentics repo",
    options: [
      { label: "Create/use local repo", value: "local" },
      { label: "Link existing path or git URL", value: "link" },
    ],
  });

  if (isCancel(selected)) {
    cancel("No agentics repo selected");
    throw new Error("No agentics repo selected");
  }

  return selected;
}

async function promptForAgenticsRepo(): Promise<string> {
  const selected = await text({
    message: "Agentics repo path or git URL",
    validate: (value) =>
      (value ?? "").trim() === "" ? "Enter a local path or git URL" : undefined,
  });

  if (isCancel(selected) || selected === undefined) {
    cancel("No agentics repo selected");
    throw new Error("No agentics repo selected");
  }

  return selected.trim();
}

async function promptForAgenticsRepoLocalPath(
  defaultPath: string,
): Promise<string> {
  const selected = await text({
    message: "Local agentics repo path",
    defaultValue: defaultPath,
    initialValue: defaultPath,
    placeholder: defaultPath,
  });

  if (isCancel(selected)) {
    cancel("No local agentics repo selected");
    throw new Error("No local agentics repo selected");
  }

  return (selected ?? "").trim() || defaultPath;
}

async function promptForAgenticsRepoRemote(): Promise<string | undefined> {
  const selected = await text({
    message: "Remote git URL (optional)",
  });

  if (isCancel(selected)) {
    cancel("Remote git URL selection cancelled");
    throw new Error("Remote git URL selection cancelled");
  }

  return (selected ?? "").trim() || undefined;
}
