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
  createMigrationImportTransaction,
  importProviderSkillsToSession,
  type ImportableSkillCandidate,
} from "./provider-skill-import.ts";
import { assertSupportedTool } from "./tool-adapters.ts";
import {
  runInitWorkflow,
  type ExistingMachineInitAction,
  type InitAgenticsRepoUpdate,
  type InitImportSkillsResult,
  type InitWorkflowRuntime,
  type MachineReinitializeAction,
} from "./init-workflow.ts";

interface InitCommandArgs {
  yes: boolean;
}

type AgenticsRepoMode = "link" | "local";

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
  return await runInitWorkflow(args, initWorkflowRuntime(context));
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

function initWorkflowRuntime(
  context: InitContext,
): InitWorkflowRuntime<JawfishConfig, AgenticsRepoInspection, Manifest> {
  return {
    ensureGlobalManifest: () => ensureGlobalManifest(context),
    ensureProjectManifest: () => ensureProjectManifest(context),
    hasCompleteMachineSetupEnv: () => hasCompleteMachineSetupEnv(context),
    hasMachineConfig: async () =>
      (await existingConfigPath(context.env)) !== undefined,
    hasProjectManifest: () =>
      exists(manifestPath("project", context.env, context.cwd)),
    importSkills: async (config) => {
      const session = await configuredAgenticsRepoSession(config, context);
      return await importSelectedSkills(session, context);
    },
    inspectAgenticsRepo: async (config) =>
      config.agenticsRepo === undefined || config.agenticsRepo === ""
        ? emptyAgenticsRepoInspection()
        : await (await configuredAgenticsRepoSession(config, context)).inspect(),
    installGlobalStarterAgentics: async (config, inspection, selected) => {
      await installGlobalStarterAgentics(
        config,
        await configuredAgenticsRepoDir(config, context),
        inspection,
        selected,
        context,
      );
    },
    installProjectAgentics: async (config, inspection, selected) => {
      await installProjectAgentics(
        config,
        await configuredAgenticsRepoDir(config, context),
        inspection,
        selected,
        context,
      );
    },
    output: {
      agenticsRepoInspection: async (inspection) => printInspection(inspection),
      agenticsRepoLocation: async (config) =>
        printConfiguredAgenticsRepoLocation(config, context),
      importSkillsResult: async (result) => printImportSkillsResult(result),
      machineConfig: async (config) => printMachineConfig(config, context),
      machineInitialized: async () => printMachineInitialized(context),
      noGlobalStarterAgenticsSelected: async () =>
        console.log("No global starter agentics selected"),
      noProjectAgenticsSelected: async () =>
        console.log("No project agentics selected"),
      noSelectableAgentics: async () =>
        console.log(
          "No registered agentics are selectable. Add or import agentics first.",
        ),
      projectInitialized: async () => printProjectInitialized(context),
      updatedAgenticsRepo: async (update) => printUpdatedAgenticsRepo(update),
      updatedDefaultTool: async (config) => printUpdatedDefaultTool(config),
    },
    prepareMachineSetup: (mode) =>
      mode === "noninteractive"
        ? prepareNoninteractiveMachineSetup(context)
        : prepareInteractiveMachineSetup(context),
    readGlobalManifest: () => readManifest("global", pathOptions(context)),
    readProjectManifest: () => readManifest("project", pathOptions(context)),
    reinitializeAgenticsRepo: (config) =>
      reinitializeAgenticsRepo(config, context),
    reinitializeDefaultTool: (config) =>
      reinitializeDefaultTool(config, context),
    saveMachineConfig: (config) => saveConfig(config, { env: context.env }),
    selectExistingMachineInitAction: (hasProjectManifest) =>
      selectExistingMachineInitAction(context, hasProjectManifest),
    selectGlobalStarterAgentics: (inspection, manifest) =>
      selectGlobalStarterAgentics(context, inspection, manifest),
    selectMachineReinitializeAction: (config) =>
      selectMachineReinitializeAction(config, context),
    selectProjectAgentics: (inspection, manifest) =>
      selectProjectAgentics(context, inspection, manifest),
    validateMachineSetup: () => validateMachineSetup(context),
    validateSelectedAgentics: assertSelectedAgenticsAvailable,
  };
}

function pathOptions(
  context: InitContext,
): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd: context.cwd, env: context.env };
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

async function prepareNoninteractiveMachineSetup(
  context: InitContext,
): Promise<JawfishConfig> {
  const defaultTool = context.env.JAWFISH_DEFAULT_TOOL ?? firstSupportedTool();
  assertSupportedTool(defaultTool, "JAWFISH_DEFAULT_TOOL");

  const selection = await noninteractiveAgenticsRepoSelection(context);
  const config: JawfishConfig = {
    agenticsRepo: selection.localPath,
    defaultTool,
  };

  await prepareAgenticsRepo(selection, context);
  await ensureGlobalManifest(context);
  return config;
}

async function prepareInteractiveMachineSetup(
  context: InitContext,
): Promise<JawfishConfig> {
  const defaultTool = await context.prompts.selectDefaultTool(defaultSupportedTools);
  assertSupportedTool(defaultTool, "selected default tool");

  const repoMode = await context.prompts.selectAgenticsRepoMode();
  const selection = await resolveAgenticsRepoSelection(repoMode, context);

  const config: JawfishConfig = {
    agenticsRepo: selection.localPath,
    defaultTool,
  };
  await prepareAgenticsRepo(selection, context);
  await ensureGlobalManifest(context);
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
  await prepareAgenticsRepoSelection(selection, pathOptions(context));
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

  assertAgenticsRepoPathSupported(config.agenticsRepo, pathOptions(context));
  return config;
}

async function ensureManifest(path: string): Promise<void> {
  if (await exists(path)) {
    return;
  }

  await writeJson(path, { jawfish: {} });
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

function printMachineInitialized(context: InitContext): void {
  console.log(`Initialized jawfish at ${configPath(jawfishHome(context.env))}`);
}

async function printConfiguredAgenticsRepoLocation(
  config: JawfishConfig,
  context: InitContext,
): Promise<void> {
  if (config.agenticsRepo === undefined || config.agenticsRepo === "") {
    return;
  }

  await printAgenticsRepoLocation(config.agenticsRepo, context);
}

function printProjectInitialized(context: InitContext): void {
  console.log(
    `Initialized project at ${manifestPath("project", context.env, context.cwd)}`,
  );
}

function printImportSkillsResult(result: InitImportSkillsResult): void {
  switch (result.kind) {
    case "delegated":
      return;
    case "imported":
      console.log(`Imported ${result.count} skills`);
      return;
    case "no-importable-skills":
      console.log("No importable skills found");
      return;
    case "no-skills-selected":
      console.log("No skills selected for import");
      return;
  }
}

function printUpdatedDefaultTool(config: JawfishConfig): void {
  console.log(`Updated default tool: ${config.defaultTool ?? "missing"}`);
}

function printUpdatedAgenticsRepo(
  update: InitAgenticsRepoUpdate<JawfishConfig>,
): void {
  console.log(`Updated agentics repo local: ${update.localPath ?? "missing"}`);
  if (update.remoteSource !== undefined) {
    console.log(`Updated agentics repo remote: ${update.remoteSource}`);
  }
}

async function reinitializeDefaultTool(
  config: JawfishConfig,
  context: InitContext,
): Promise<JawfishConfig> {
  const defaultTool = await context.prompts.selectDefaultTool(defaultSupportedTools);
  assertSupportedTool(defaultTool, "selected default tool");

  const nextConfig = { ...config, defaultTool };
  await saveConfig(nextConfig, { env: context.env });
  return nextConfig;
}

async function reinitializeAgenticsRepo(
  config: JawfishConfig,
  context: InitContext,
): Promise<InitAgenticsRepoUpdate<JawfishConfig>> {
  const repoMode = await context.prompts.selectAgenticsRepoMode();
  const selection = await resolveAgenticsRepoSelection(repoMode, context);

  await prepareAgenticsRepo(selection, context);
  const nextConfig = { ...config, agenticsRepo: selection.localPath };
  await saveConfig(nextConfig, { env: context.env });
  return {
    config: nextConfig,
    localPath: selection.localPath,
    remoteSource: selection.remoteSource,
  };
}

async function importSelectedSkills(
  session: AgenticsRepoSession,
  context: InitContext,
): Promise<InitImportSkillsResult> {
  const options = pathOptions(context);
  const transaction = await createMigrationImportTransaction(
    session,
    defaultSupportedTools,
    ["global", "project"],
    options,
  );
  const preview = transaction.preview;

  if (preview.candidates.length === 0) {
    return { kind: "no-importable-skills" };
  }

  if (context.prompts.selectImportSkills === undefined) {
    await importSelectedProviders(session, context);
    return { kind: "delegated" };
  }

  const selectedIds = await context.prompts.selectImportSkills(
    preview.candidates,
  );
  if (selectedIds.length === 0) {
    return { kind: "no-skills-selected" };
  }

  const result = await transaction.applySelected(selectedIds, "import skills");
  if (!result.pushed) {
    throw new Error("Import failed");
  }
  return { count: result.imported.length, kind: "imported" };
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

  const options = pathOptions(context);
  for (const provider of selectedProviderNames) {
    const result = await importProviderSkillsToSession(
      session,
      provider,
      options,
    );
    if (result !== 0) {
      throw new Error(`Import failed for ${provider}`);
    }
  }
}

async function installGlobalStarterAgentics(
  config: JawfishConfig,
  agenticsRepoDir: string,
  inspection: AgenticsRepoInspection,
  selected: string[],
  context: InitContext,
): Promise<void> {
  const options = pathOptions(context);
  const tool = configuredDefaultTool(config, context);
  const catalog = catalogFromInspection(inspection);
  for (const name of selected) {
    await installManifestEntry(
      agenticsRepoDir,
      catalog,
      name,
      "global",
      tool,
      options,
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

async function installProjectAgentics(
  config: JawfishConfig,
  agenticsRepoDir: string,
  inspection: AgenticsRepoInspection,
  selected: string[],
  context: InitContext,
): Promise<void> {
  const options = pathOptions(context);
  const tool = configuredDefaultTool(config, context);
  const catalog = catalogFromInspection(inspection);
  for (const name of selected) {
    await installManifestEntry(
      agenticsRepoDir,
      catalog,
      name,
      "project",
      tool,
      options,
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
    assertSupportedTool(provider, "selected import provider");
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

  assertSupportedTool(config.defaultTool, "config defaultTool");
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
  return await inspectionAgenticsRepoDir(agenticsRepo, pathOptions(context));
}

async function configuredAgenticsRepoSession(
  config: JawfishConfig,
  context: InitContext,
): Promise<AgenticsRepoSession> {
  return createAgenticsRepoSession(
    await configuredAgenticsRepoDir(config, context),
  );
}

function emptyAgenticsRepoInspection(): AgenticsRepoInspection {
  return {
    broken: [],
    counts: { agent: 0, prompt: 0, skill: 0 },
    skipped: [],
    usable: [],
    usableNames: [],
  };
}

async function printAgenticsRepoLocation(
  agenticsRepo: string,
  context: InitContext,
): Promise<void> {
  const agenticsRepoDir = await inspectionAgenticsRepoDir(
    agenticsRepo,
    pathOptions(context),
  );
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
