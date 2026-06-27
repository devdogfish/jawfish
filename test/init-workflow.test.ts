import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  runInitWorkflow,
  type InitImportSkillsResult,
  type InitWorkflowRuntime,
} from "../src/init-workflow.ts";

interface TestConfig {
  agenticsRepo: string;
  defaultTool: string;
}

interface TestInspection {
  usableNames: string[];
}

interface TestManifest {
  jawfish: Record<string, { tool: string }>;
}

function importResult(
  kind: InitImportSkillsResult["kind"],
  count = 0,
): InitImportSkillsResult {
  if (kind === "imported") {
    return { count, kind };
  }

  return { kind };
}

function createRuntime(
  overrides: Partial<
    InitWorkflowRuntime<TestConfig, TestInspection, TestManifest>
  > = {},
): {
  calls: string[];
  runtime: InitWorkflowRuntime<TestConfig, TestInspection, TestManifest>;
} {
  const calls: string[] = [];
  const config = { agenticsRepo: "/agentics", defaultTool: "codex" };
  const inspections: TestInspection[] = [
    { usableNames: [] },
    { usableNames: ["focus"] },
    { usableNames: ["focus"] },
  ];
  const manifest = { jawfish: {} };

  const runtime: InitWorkflowRuntime<TestConfig, TestInspection, TestManifest> = {
    emit: ({ action, state }) => {
      const transition =
        action === undefined ? `state:${state}` : `state:${state}:${action}`;
      calls.push(transition);
    },
    ensureGlobalManifest: async () => {
      calls.push("ensure-global-manifest");
    },
    ensureProjectManifest: async () => {
      calls.push("ensure-project-manifest");
    },
    hasCompleteMachineSetupEnv: () => false,
    hasMachineConfig: async () => false,
    hasProjectManifest: async () => false,
    importSkills: async () => {
      calls.push("import-skills");
      return importResult("imported", 1);
    },
    inspectAgenticsRepo: async () => {
      calls.push("inspect");
      return inspections.shift() ?? { usableNames: ["focus"] };
    },
    installGlobalStarterAgentics: async (_config, _inspection, selected) => {
      calls.push(`install-global:${selected.join(",")}`);
    },
    installProjectAgentics: async (_config, _inspection, selected) => {
      calls.push(`install-project:${selected.join(",")}`);
    },
    output: {
      agenticsRepoInspection: async (inspection) => {
        calls.push(`output-inspection:${inspection.usableNames.join(",")}`);
      },
      agenticsRepoLocation: async () => {
        calls.push("output-repo-location");
      },
      importSkillsResult: async (result) => {
        calls.push(`output-import:${result.kind}`);
      },
      machineConfig: async () => {
        calls.push("output-machine-config");
      },
      machineInitialized: async () => {
        calls.push("output-machine-initialized");
      },
      noGlobalStarterAgenticsSelected: async () => {
        calls.push("output-no-global-starters");
      },
      noProjectAgenticsSelected: async () => {
        calls.push("output-no-project-agentics");
      },
      noSelectableAgentics: async () => {
        calls.push("output-no-selectable");
      },
      projectInitialized: async () => {
        calls.push("output-project-initialized");
      },
      updatedAgenticsRepo: async () => {
        calls.push("output-updated-agentics-repo");
      },
      updatedDefaultTool: async () => {
        calls.push("output-updated-default-tool");
      },
    },
    prepareMachineSetup: async (mode) => {
      calls.push(`prepare-machine:${mode}`);
      return config;
    },
    readGlobalManifest: async () => manifest,
    readProjectManifest: async () => manifest,
    reinitializeAgenticsRepo: async () => {
      calls.push("reinitialize-agentics-repo");
      return { config };
    },
    reinitializeDefaultTool: async () => {
      calls.push("reinitialize-default-tool");
      return config;
    },
    saveMachineConfig: async () => {
      calls.push("save-machine-config");
    },
    selectExistingMachineInitAction: async () => "project",
    selectGlobalStarterAgentics: async () => {
      calls.push("select-global-starters");
      return ["focus"];
    },
    selectMachineReinitializeAction: async () => "done",
    selectProjectAgentics: async () => {
      calls.push("select-project-agentics");
      return ["focus"];
    },
    validateMachineSetup: async () => {
      calls.push("validate-machine");
      return config;
    },
    validateSelectedAgentics: (selected) => {
      calls.push(`validate-selection:${selected.join(",")}`);
    },
    ...overrides,
  };

  return { calls, runtime };
}

describe("init workflow", () => {
  test("first-run setup imports before starter selection for empty repos, then installs project entries", async () => {
    const { calls, runtime } = createRuntime();

    const exitCode = await runInitWorkflow({ yes: false }, runtime);

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      "state:first-run-machine-setup",
      "state:agentics-repo-preparation",
      "prepare-machine:interactive",
      "state:machine-starter-setup",
      "inspect",
      "output-inspection:",
      "state:import-before-starter-selection",
      "state:migration-import",
      "import-skills",
      "output-import:imported",
      "inspect",
      "output-inspection:focus",
      "select-global-starters",
      "validate-selection:focus",
      "state:global-starter-install",
      "install-global:focus",
      "save-machine-config",
      "output-machine-initialized",
      "output-repo-location",
      "state:project-setup",
      "inspect",
      "output-project-initialized",
      "output-inspection:focus",
      "select-project-agentics",
      "validate-selection:focus",
      "state:project-install",
      "install-project:focus",
    ]);
  });

  test("existing machine init -y runs only noninteractive project setup", async () => {
    const { calls, runtime } = createRuntime({
      hasMachineConfig: async () => true,
    });

    const exitCode = await runInitWorkflow({ yes: true }, runtime);

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      "validate-machine",
      "state:existing-machine-setup",
      "state:noninteractive-project-setup",
      "ensure-project-manifest",
      "output-project-initialized",
      "inspect",
      "output-inspection:",
    ]);
  });

  test("first-run init -y creates machine setup without project install", async () => {
    const { calls, runtime } = createRuntime();

    const exitCode = await runInitWorkflow({ yes: true }, runtime);

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      "state:noninteractive-machine-setup",
      "state:agentics-repo-preparation",
      "prepare-machine:noninteractive",
      "save-machine-config",
      "output-machine-initialized",
      "output-repo-location",
      "inspect",
      "output-inspection:",
    ]);
  });

  test("existing machine reinitialize loops through selected machine actions", async () => {
    const actions: Array<"default-tool" | "agentics-repo" | "done"> = [
      "default-tool",
      "agentics-repo",
      "done",
    ];
    const { calls, runtime } = createRuntime({
      hasMachineConfig: async () => true,
      selectExistingMachineInitAction: async () => "reinitialize",
      selectMachineReinitializeAction: async () => {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    });

    const exitCode = await runInitWorkflow({ yes: false }, runtime);

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      "validate-machine",
      "state:existing-machine-setup",
      "state:machine-reinitialize",
      "ensure-global-manifest",
      "output-machine-config",
      "state:machine-reinitialize-action:default-tool",
      "reinitialize-default-tool",
      "output-updated-default-tool",
      "output-machine-config",
      "state:machine-reinitialize-action:agentics-repo",
      "reinitialize-agentics-repo",
      "output-updated-agentics-repo",
      "inspect",
      "output-inspection:",
      "output-machine-config",
      "state:machine-reinitialize-action:done",
    ]);
  });
});
