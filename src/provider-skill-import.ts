import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeCatalog, type Catalog } from "./catalog.ts";
import { exists } from "./files.ts";
import { inferredLocalGitUpstream } from "./git-source.ts";
import {
  installedFiles,
  managedMarkerFile,
  readManifest,
  resolveInside,
  writeJson,
  writeManifest,
} from "./install.ts";
import {
  pushAgenticsRepoChanges,
  type AgenticsRepoSession,
} from "./agentics-repo.ts";
import { toolPaths } from "./config.ts";
import {
  destinationSpec,
  type InstallScope,
  typeFolder,
} from "./tool-adapters.ts";

interface PathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  upstream?: string;
}

export interface ImportableSkillCandidate extends DiscoveredSkill {
  id: string;
  provider: string;
  scope: InstallScope;
}

export interface ImportableSkillDiscovery {
  candidates: ImportableSkillCandidate[];
  conflicts: ImportSkillsSkip[];
  skipped: ImportSkillsSkip[];
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

    plan.imported.push({
      name: entry.name,
      path: sourcePath,
      upstream: await inferredLocalGitUpstream(sourcePath),
    });
  }

  plan.conflicts.sort();
  plan.imported.sort((left, right) => left.name.localeCompare(right.name));
  plan.skipped.sort((left, right) => left.name.localeCompare(right.name));
  return plan;
}

export async function discoverImportableSkills(
  providers: readonly string[],
  scopes: readonly InstallScope[],
  catalog: Catalog,
  options: PathOptions = {},
): Promise<ImportableSkillDiscovery> {
  const discovery: ImportableSkillDiscovery = {
    candidates: [],
    conflicts: [],
    skipped: [],
  };

  for (const provider of providers) {
    for (const scope of scopes) {
      const sourceRoot = skillRoot(provider, scope, options);
      const plan = await planSkillImport(sourceRoot, catalog);
      discovery.candidates.push(
        ...plan.imported.map((skill) => ({
          ...skill,
          id: importableSkillId(provider, scope, skill.name),
          provider,
          scope,
        })),
      );
      discovery.conflicts.push(
        ...plan.conflicts.map((name) => ({
          name: `${provider}/${scope}/${name}`,
          reason: "catalog conflict",
        })),
      );
      discovery.skipped.push(
        ...plan.skipped.map((skip) => ({
          name: `${provider}/${scope}/${skip.name}`,
          reason: skip.reason,
        })),
      );
    }
  }

  discovery.candidates.sort((left, right) =>
    left.provider.localeCompare(right.provider) ||
    left.scope.localeCompare(right.scope) ||
    left.name.localeCompare(right.name),
  );
  discovery.conflicts.sort((left, right) => left.name.localeCompare(right.name));
  discovery.skipped.sort((left, right) => left.name.localeCompare(right.name));
  return discovery;
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
  manifestScope: InstallScope = "global",
): Promise<void> {
  const manifest = await readManifest(manifestScope, options);

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
      ...(skill.upstream === undefined ? {} : { upstream: skill.upstream }),
    };
    manifest.jawfish[skill.name] = { tool: provider };
    await adoptGlobalSkill(skill, provider);
  }

  await writeManifest(manifestScope, manifest, options);
}

export async function applySelectedSkillImports(
  agenticsRepoDir: string,
  catalog: Catalog,
  skills: ImportableSkillCandidate[],
  options: PathOptions = {},
): Promise<void> {
  assertUniqueImportNames(skills);

  for (const skill of skills) {
    await applySkillImport(
      agenticsRepoDir,
      catalog,
      skill.provider,
      [skill],
      options,
      skill.scope,
    );
  }
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

export async function importProviderSkillsToSession(
  session: AgenticsRepoSession,
  provider: string,
  options: PathOptions = {},
): Promise<number> {
  const catalog = await session.readCatalog();
  const sourceRoot = globalSkillRoot(provider, options);
  const plan = await planSkillImport(sourceRoot, catalog);

  printImportSkillsPlan(provider, sourceRoot, plan);

  if (plan.imported.length === 0) {
    console.log("No importable skills found");
    return 0;
  }

  await applySkillImport(session.dir, catalog, provider, plan.imported, options);
  await session.writeCatalog(catalog);
  if (!(await session.pushChanges(`import skills from ${provider}`))) {
    return 1;
  }

  console.log(`Imported ${plan.imported.length} skills from ${provider}`);
  return 0;
}

export function globalSkillRoot(
  tool: string,
  options: PathOptions = {},
): string {
  return skillRoot(tool, "global", options);
}

export function projectSkillRoot(
  tool: string,
  options: PathOptions = {},
): string {
  return skillRoot(tool, "project", options);
}

export function importableSkillId(
  provider: string,
  scope: InstallScope,
  name: string,
): string {
  return `${provider}:${scope}:${name}`;
}

function skillRoot(
  tool: string,
  scope: InstallScope,
  options: PathOptions = {},
): string {
  return dirname(
    destinationSpec(
      "__jawfish_import_probe__",
      "skill",
      scope,
      tool,
      toolPaths(options.env, options.cwd),
    ).path,
  );
}

function assertUniqueImportNames(skills: ImportableSkillCandidate[]): void {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  if (duplicates.length > 0) {
    throw new Error(`Selected import skills contain duplicate names: ${duplicates.join(", ")}`);
  }
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
