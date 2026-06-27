export type ExistingMachineInitAction = "project" | "reinitialize";

export type MachineReinitializeAction =
  | "agentics"
  | "agentics-repo"
  | "default-tool"
  | "done"
  | "global-starters"
  | "import-skills";

export type InitWorkflowState =
  | "agentics-repo-preparation"
  | "existing-machine-setup"
  | "first-run-machine-setup"
  | "global-starter-install"
  | "import-before-starter-selection"
  | "machine-reinitialize"
  | "machine-reinitialize-action"
  | "machine-starter-setup"
  | "migration-import"
  | "noninteractive-machine-setup"
  | "noninteractive-project-setup"
  | "project-install"
  | "project-setup";

export interface InitWorkflowTransition {
  action?: MachineReinitializeAction;
  state: InitWorkflowState;
}

export interface InitWorkflowArgs {
  yes: boolean;
}

export interface InitWorkflowInspection {
  usableNames: readonly string[];
}

export type InitImportSkillsResult =
  | { count: number; kind: "imported" }
  | { kind: "delegated" | "no-importable-skills" | "no-skills-selected" };

export interface InitAgenticsRepoUpdate<TConfig> {
  config: TConfig;
  localPath?: string;
  remoteSource?: string;
}

export interface InitWorkflowOutput<
  TConfig,
  TInspection extends InitWorkflowInspection,
> {
  agenticsRepoInspection: (inspection: TInspection) => Promise<void>;
  agenticsRepoLocation: (config: TConfig) => Promise<void>;
  importSkillsResult: (result: InitImportSkillsResult) => Promise<void>;
  machineConfig: (config: TConfig) => Promise<void>;
  machineInitialized: (config: TConfig) => Promise<void>;
  noGlobalStarterAgenticsSelected: () => Promise<void>;
  noProjectAgenticsSelected: () => Promise<void>;
  noSelectableAgentics: () => Promise<void>;
  projectInitialized: () => Promise<void>;
  updatedAgenticsRepo: (
    update: InitAgenticsRepoUpdate<TConfig>,
  ) => Promise<void>;
  updatedDefaultTool: (config: TConfig) => Promise<void>;
}

export interface InitWorkflowRuntime<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
> {
  emit?: (transition: InitWorkflowTransition) => Promise<void> | void;
  ensureGlobalManifest: () => Promise<void>;
  ensureProjectManifest: () => Promise<void>;
  hasCompleteMachineSetupEnv: () => boolean;
  hasMachineConfig: () => Promise<boolean>;
  hasProjectManifest: () => Promise<boolean>;
  importSkills: (config: TConfig) => Promise<InitImportSkillsResult>;
  inspectAgenticsRepo: (config: TConfig) => Promise<TInspection>;
  installGlobalStarterAgentics: (
    config: TConfig,
    inspection: TInspection,
    selectedNames: string[],
  ) => Promise<void>;
  installProjectAgentics: (
    config: TConfig,
    inspection: TInspection,
    selectedNames: string[],
  ) => Promise<void>;
  output: InitWorkflowOutput<TConfig, TInspection>;
  prepareMachineSetup: (mode: "interactive" | "noninteractive") => Promise<TConfig>;
  readGlobalManifest: () => Promise<TManifest>;
  readProjectManifest: () => Promise<TManifest>;
  reinitializeAgenticsRepo: (
    config: TConfig,
  ) => Promise<InitAgenticsRepoUpdate<TConfig>>;
  reinitializeDefaultTool: (config: TConfig) => Promise<TConfig>;
  saveMachineConfig: (config: TConfig) => Promise<void>;
  selectExistingMachineInitAction: (
    hasProjectManifest: boolean,
  ) => Promise<ExistingMachineInitAction>;
  selectGlobalStarterAgentics: (
    inspection: TInspection,
    manifest: TManifest,
  ) => Promise<string[]>;
  selectMachineReinitializeAction: (
    config: TConfig,
  ) => Promise<MachineReinitializeAction>;
  selectProjectAgentics: (
    inspection: TInspection,
    manifest: TManifest,
  ) => Promise<string[]>;
  validateMachineSetup: () => Promise<TConfig>;
  validateSelectedAgentics: (
    selectedNames: string[],
    inspection: TInspection,
  ) => void;
}

export async function runInitWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  args: InitWorkflowArgs,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<number> {
  if (!(await runtime.hasMachineConfig())) {
    return await runMissingMachineSetupWorkflow(args, runtime);
  }

  const config = await runtime.validateMachineSetup();
  await emit(runtime, { state: "existing-machine-setup" });

  if (args.yes) {
    await emit(runtime, { state: "noninteractive-project-setup" });
    await runtime.ensureProjectManifest();
    await runtime.output.projectInitialized();
    await runtime.output.agenticsRepoInspection(
      await runtime.inspectAgenticsRepo(config),
    );
    return 0;
  }

  await runExistingMachineSetupWorkflow(config, runtime);
  return 0;
}

async function runMissingMachineSetupWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  args: InitWorkflowArgs,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<number> {
  const noninteractive = args.yes || runtime.hasCompleteMachineSetupEnv();
  await emit(runtime, {
    state: noninteractive
      ? "noninteractive-machine-setup"
      : "first-run-machine-setup",
  });
  await emit(runtime, { state: "agentics-repo-preparation" });

  const config = await runtime.prepareMachineSetup(
    noninteractive ? "noninteractive" : "interactive",
  );

  if (!noninteractive) {
    await runMachineStarterSetupWorkflow(config, runtime);
  }

  await runtime.saveMachineConfig(config);
  await runtime.output.machineInitialized(config);
  await runtime.output.agenticsRepoLocation(config);

  if (args.yes) {
    await runtime.output.agenticsRepoInspection(
      await runtime.inspectAgenticsRepo(config),
    );
    return 0;
  }

  await runProjectSetupWorkflow(config, runtime);
  return 0;
}

async function runExistingMachineSetupWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  config: TConfig,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  const hasProjectManifest = await runtime.hasProjectManifest();
  const action = await runtime.selectExistingMachineInitAction(hasProjectManifest);

  if (action === "project") {
    await runProjectSetupWorkflow(config, runtime);
    return;
  }

  await runMachineReinitializeWorkflow(config, runtime);
}

async function runMachineReinitializeWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  initialConfig: TConfig,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  let config = initialConfig;

  await emit(runtime, { state: "machine-reinitialize" });
  await runtime.ensureGlobalManifest();

  while (true) {
    await runtime.output.machineConfig(config);
    const action = await runtime.selectMachineReinitializeAction(config);
    await emit(runtime, { action, state: "machine-reinitialize-action" });

    switch (action) {
      case "done":
        return;
      case "default-tool":
        config = await runtime.reinitializeDefaultTool(config);
        await runtime.output.updatedDefaultTool(config);
        break;
      case "agentics-repo": {
        const update = await runtime.reinitializeAgenticsRepo(config);
        config = update.config;
        await runtime.output.updatedAgenticsRepo(update);
        await runtime.output.agenticsRepoInspection(
          await runtime.inspectAgenticsRepo(config),
        );
        break;
      }
      case "agentics":
      case "global-starters":
      case "import-skills":
        await runImportAndStarterEditWorkflow(config, runtime);
        break;
    }
  }
}

async function runMachineStarterSetupWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  config: TConfig,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  await emit(runtime, { state: "machine-starter-setup" });
  let inspection = await runtime.inspectAgenticsRepo(config);

  await runtime.output.agenticsRepoInspection(inspection);

  const shouldImportBeforeStarterSelection = !hasUsableAgentics(inspection);
  if (shouldImportBeforeStarterSelection) {
    await emit(runtime, { state: "import-before-starter-selection" });
    await runMigrationImportWorkflow(config, runtime);
    inspection = await runtime.inspectAgenticsRepo(config);
    if (hasUsableAgentics(inspection)) {
      await runtime.output.agenticsRepoInspection(inspection);
    }
  }

  if (hasUsableAgentics(inspection)) {
    await runGlobalStarterInstallWorkflow(config, inspection, runtime);
  }

  if (!shouldImportBeforeStarterSelection) {
    await runMigrationImportWorkflow(config, runtime);
  }
}

async function runImportAndStarterEditWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  config: TConfig,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  await runMigrationImportWorkflow(config, runtime);

  const inspection = await runtime.inspectAgenticsRepo(config);
  await runtime.output.agenticsRepoInspection(inspection);
  if (!hasUsableAgentics(inspection)) {
    await runtime.output.noSelectableAgentics();
    return;
  }

  await runGlobalStarterInstallWorkflow(config, inspection, runtime);
}

async function runMigrationImportWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  config: TConfig,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  await emit(runtime, { state: "migration-import" });
  await runtime.output.importSkillsResult(await runtime.importSkills(config));
}

async function runGlobalStarterInstallWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  config: TConfig,
  inspection: TInspection,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  const manifest = await runtime.readGlobalManifest();
  const selected = await runtime.selectGlobalStarterAgentics(
    inspection,
    manifest,
  );
  if (selected.length === 0) {
    await runtime.output.noGlobalStarterAgenticsSelected();
    return;
  }

  runtime.validateSelectedAgentics(selected, inspection);
  await emit(runtime, { state: "global-starter-install" });
  await runtime.installGlobalStarterAgentics(config, inspection, selected);
}

async function runProjectSetupWorkflow<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  config: TConfig,
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
): Promise<void> {
  await emit(runtime, { state: "project-setup" });

  const inspection = await runtime.inspectAgenticsRepo(config);
  const manifest = await runtime.readProjectManifest();

  await runtime.output.projectInitialized();
  await runtime.output.agenticsRepoInspection(inspection);

  if (!hasUsableAgentics(inspection)) {
    await runtime.ensureProjectManifest();
    await runtime.output.noSelectableAgentics();
    return;
  }

  const selected = await runtime.selectProjectAgentics(inspection, manifest);
  if (selected.length === 0) {
    await runtime.ensureProjectManifest();
    await runtime.output.noProjectAgenticsSelected();
    return;
  }

  runtime.validateSelectedAgentics(selected, inspection);
  await emit(runtime, { state: "project-install" });
  await runtime.installProjectAgentics(config, inspection, selected);
}

async function emit<
  TConfig,
  TInspection extends InitWorkflowInspection,
  TManifest,
>(
  runtime: InitWorkflowRuntime<TConfig, TInspection, TManifest>,
  transition: InitWorkflowTransition,
): Promise<void> {
  await runtime.emit?.(transition);
}

function hasUsableAgentics(inspection: InitWorkflowInspection): boolean {
  return inspection.usableNames.length > 0;
}
