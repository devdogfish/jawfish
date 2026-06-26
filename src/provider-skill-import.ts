import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeCatalog, type Catalog } from "./catalog.ts";
import { exists } from "./files.ts";
import {
  installedFiles,
  managedMarkerFile,
  readManifest,
  resolveInside,
  writeJson,
  writeManifest,
} from "./install.ts";
import { pushAgenticsRepoChanges } from "./agentics-repo.ts";
import { toolPaths } from "./config.ts";
import { destinationSpec, typeFolder } from "./tool-adapters.ts";

interface PathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DiscoveredSkill {
  name: string;
  path: string;
}

export interface ImportSkillsPlan {
  conflicts: string[];
  imported: DiscoveredSkill[];
  skipped: ImportSkillsSkip[];
}

export interface ImportSkillsSkip {
  name: string;
  reason: string;
}

export async function planSkillImport(
  sourceRoot: string,
  catalog: Catalog,
): Promise<ImportSkillsPlan> {
  const plan: ImportSkillsPlan = { conflicts: [], imported: [], skipped: [] };
  if (!(await exists(sourceRoot))) {
    return plan;
  }

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const sourcePath = join(sourceRoot, entry.name);
    const skillPath = join(sourcePath, "SKILL.md");
    if (!(await exists(skillPath))) {
      plan.skipped.push({
        name: entry.name,
        reason: "missing SKILL.md",
      });
      continue;
    }

    if (Object.hasOwn(catalog.jawfish, entry.name)) {
      plan.conflicts.push(entry.name);
      continue;
    }

    plan.imported.push({ name: entry.name, path: sourcePath });
  }

  plan.conflicts.sort();
  plan.imported.sort((left, right) => left.name.localeCompare(right.name));
  plan.skipped.sort((left, right) => left.name.localeCompare(right.name));
  return plan;
}

export function printImportSkillsPlan(
  provider: string,
  sourceRoot: string,
  plan: ImportSkillsPlan,
): void {
  console.log(`Import skills from ${provider}`);
  console.log(`source: ${sourceRoot}`);
  console.log(
    `import: ${formatSummaryNames(plan.imported.map((skill) => skill.name))}`,
  );
  console.log(`conflicts: ${formatSummaryNames(plan.conflicts)}`);
  console.log(`skipped: ${formatImportSkillSkips(plan.skipped)}`);
}

export async function applySkillImport(
  agenticsRepoDir: string,
  catalog: Catalog,
  provider: string,
  skills: DiscoveredSkill[],
  options: PathOptions = {},
): Promise<void> {
  const manifest = await readManifest("global", options);

  for (const skill of skills) {
    const packagePath = join(typeFolder("skill"), skill.name);
    const destination = resolveInside(agenticsRepoDir, packagePath);

    await rm(destination, { force: true, recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    await cp(skill.path, destination, { recursive: true });
    await rm(join(destination, managedMarkerFile), { force: true });

    catalog.jawfish[skill.name] = {
      description: "",
      path: packagePath,
      type: "skill",
    };
    manifest.jawfish[skill.name] = { tool: provider };
    await adoptGlobalSkill(skill, provider);
  }

  await writeManifest("global", manifest, options);
}

export async function importProviderSkills(
  agenticsRepoDir: string,
  catalog: Catalog,
  provider: string,
  options: PathOptions = {},
): Promise<number> {
  const sourceRoot = globalSkillRoot(provider, options);
  const plan = await planSkillImport(sourceRoot, catalog);

  printImportSkillsPlan(provider, sourceRoot, plan);

  if (plan.imported.length === 0) {
    console.log("No importable skills found");
    return 0;
  }

  await applySkillImport(agenticsRepoDir, catalog, provider, plan.imported, options);
  await writeCatalog(agenticsRepoDir, catalog);
  if (!(await pushAgenticsRepoChanges(agenticsRepoDir, `import skills from ${provider}`))) {
    return 1;
  }

  console.log(`Imported ${plan.imported.length} skills from ${provider}`);
  return 0;
}

export function globalSkillRoot(
  tool: string,
  options: PathOptions = {},
): string {
  return dirname(
    destinationSpec(
      "__jawfish_import_probe__",
      "skill",
      "global",
      tool,
      toolPaths(options.env, options.cwd),
    ).path,
  );
}

function formatImportSkillSkips(skipped: ImportSkillsSkip[]): string {
  if (skipped.length === 0) {
    return "none";
  }

  return skipped.map((skip) => `${skip.name} (${skip.reason})`).join(", ");
}

function formatSummaryNames(names: string[]): string {
  if (names.length === 0) {
    return "none";
  }

  return names.join(", ");
}

async function adoptGlobalSkill(
  skill: DiscoveredSkill,
  provider: string,
): Promise<void> {
  await writeJson(join(skill.path, managedMarkerFile), {
    files: (await installedFiles(skill.path)).sort(),
    name: skill.name,
    tool: provider,
    type: "skill",
  });
}
