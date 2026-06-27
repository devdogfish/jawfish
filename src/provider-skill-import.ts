import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeCatalog, type Catalog } from "./catalog.ts";
import { exists } from "./files.ts";
import { inferredLocalGitUpstream } from "./git-source.ts";
import {
  adoptMaterialized,
  readManifest,
  resolveInside,
  stripMaterializationMetadata,
  writeManifest,
} from "./install.ts";
import {
  pushAgenticsRepoChanges,
  type AgenticsRepoSession,
} from "./agentics-repo.ts";
import { toolPaths } from "./config.ts";
import {
  sourceProviderSkillRoot,
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
  providers: string[];
  scopes: InstallScope[];
  skipped: ImportSkillsSkip[];
}

export interface ImportSkillsPlan {
  conflicts: string[];
  imported: DiscoveredSkill[];
  skipped: ImportSkillsSkip[];
}

export interface ImportSkillsSkip {
  name: string;
  provider?: string;
  reason: string;
  scope?: InstallScope;
}

export interface MigrationImportApplyResult {
  imported: ImportableSkillCandidate[];
  pushed: boolean;
}

export interface MigrationImportTransaction {
  applySelected: (
    selectedIds: readonly string[],
    message: string,
  ) => Promise<MigrationImportApplyResult>;
  preview: ImportableSkillDiscovery;
}

interface ProviderSkillImportTarget {
  dir: string;
  pushChanges: (message: string) => Promise<boolean>;
  writeCatalog: (catalog: Catalog) => Promise<void>;
}

const catalogConflictReason = "catalog conflict";
const duplicateDiscoveredSkillReason = "duplicate discovered skill name";

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
    providers: [...providers],
    scopes: [...scopes],
    skipped: [],
  };

  for (const provider of providers) {
    for (const scope of scopes) {
      const sourceRoot = skillRoot(provider, scope, options);
      const plan = await planSkillImport(sourceRoot, catalog);
      addScopedImportPlan(discovery, provider, scope, plan);
    }
  }

  markDuplicateImportNamesAsConflicts(discovery);
  sortImportableSkillDiscovery(discovery);
  return discovery;
}

export function previewImportSkillsPlan(
  discovery: ImportableSkillDiscovery,
): ImportSkillsPlan {
  return {
    conflicts: discovery.conflicts.map((conflict) => conflict.name),
    imported: discovery.candidates,
    skipped: discovery.skipped.map((skip) => ({
      name: skip.name,
      reason: skip.reason,
    })),
  };
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
  skills: readonly DiscoveredSkill[],
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
    await stripMaterializationMetadata(destination);

    catalog.jawfish[skill.name] = {
      description: "",
      path: packagePath,
      type: "skill",
      ...(skill.upstream === undefined ? {} : { upstream: skill.upstream }),
    };
    manifest.jawfish[skill.name] = { tool: provider };
    await adoptMaterialized(
      skill.name,
      "skill",
      manifestScope,
      provider,
      options,
    );
  }

  await writeManifest(manifestScope, manifest, options);
}

export async function applySelectedSkillImports(
  agenticsRepoDir: string,
  catalog: Catalog,
  skills: readonly ImportableSkillCandidate[],
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

export async function createMigrationImportTransaction(
  session: AgenticsRepoSession,
  providers: readonly string[],
  scopes: readonly InstallScope[],
  options: PathOptions = {},
): Promise<MigrationImportTransaction> {
  const catalog = await session.readCatalog();
  return await createMigrationImportTransactionForTarget(
    session,
    catalog,
    providers,
    scopes,
    options,
  );
}

export async function importProviderSkills(
  agenticsRepoDir: string,
  catalog: Catalog,
  provider: string,
  options: PathOptions = {},
): Promise<number> {
  const transaction = await createMigrationImportTransactionForTarget(
    {
      dir: agenticsRepoDir,
      pushChanges: (message) =>
        pushAgenticsRepoChanges(agenticsRepoDir, message),
      writeCatalog: (catalog) => writeCatalog(agenticsRepoDir, catalog),
    },
    catalog,
    [provider],
    ["global"],
    options,
  );
  return await importProviderSkillsWithTransaction(
    provider,
    transaction,
    options,
  );
}

export async function importProviderSkillsToSession(
  session: AgenticsRepoSession,
  provider: string,
  options: PathOptions = {},
): Promise<number> {
  const transaction = await createMigrationImportTransaction(
    session,
    [provider],
    ["global"],
    options,
  );
  return await importProviderSkillsWithTransaction(
    provider,
    transaction,
    options,
  );
}

async function createMigrationImportTransactionForTarget(
  target: ProviderSkillImportTarget,
  catalog: Catalog,
  providers: readonly string[],
  scopes: readonly InstallScope[],
  options: PathOptions,
): Promise<MigrationImportTransaction> {
  const preview = await discoverImportableSkills(
    providers,
    scopes,
    catalog,
    options,
  );

  return {
    applySelected: (selectedIds, message) =>
      applyMigrationImportSelection(
        target,
        catalog,
        preview,
        selectedIds,
        message,
        options,
      ),
    preview,
  };
}

async function applyMigrationImportSelection(
  target: ProviderSkillImportTarget,
  catalog: Catalog,
  preview: ImportableSkillDiscovery,
  selectedIds: readonly string[],
  message: string,
  options: PathOptions,
): Promise<MigrationImportApplyResult> {
  const selected = selectedImportCandidates(preview, selectedIds);
  if (selected.length === 0) {
    return { imported: [], pushed: true };
  }

  await applySelectedSkillImports(target.dir, catalog, selected, options);
  await target.writeCatalog(catalog);
  const pushed = await target.pushChanges(message);
  return { imported: selected, pushed };
}

async function importProviderSkillsWithTransaction(
  provider: string,
  transaction: MigrationImportTransaction,
  options: PathOptions,
): Promise<number> {
  const sourceRoot = globalSkillRoot(provider, options);
  const plan = previewImportSkillsPlan(transaction.preview);

  printImportSkillsPlan(provider, sourceRoot, plan);

  if (plan.imported.length === 0) {
    console.log("No importable skills found");
    return 0;
  }

  const result = await transaction.applySelected(
    transaction.preview.candidates.map((skill) => skill.id),
    `import skills from ${provider}`,
  );
  if (!result.pushed) {
    return 1;
  }

  console.log(`Imported ${result.imported.length} skills from ${provider}`);
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
  return sourceProviderSkillRoot(
    tool,
    scope,
    toolPaths(options.env, options.cwd),
  );
}

function addScopedImportPlan(
  discovery: ImportableSkillDiscovery,
  provider: string,
  scope: InstallScope,
  plan: ImportSkillsPlan,
): void {
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
      name,
      provider,
      reason: catalogConflictReason,
      scope,
    })),
  );
  discovery.skipped.push(
    ...plan.skipped.map((skip) => ({
      name: skip.name,
      provider,
      reason: skip.reason,
      scope,
    })),
  );
}

function markDuplicateImportNamesAsConflicts(
  discovery: ImportableSkillDiscovery,
): void {
  const duplicateNames = duplicateImportCandidateNames(discovery.candidates);
  if (duplicateNames.size === 0) {
    return;
  }

  discovery.conflicts.push(
    ...discovery.candidates
      .filter((candidate) => duplicateNames.has(candidate.name))
      .map((candidate) => ({
        name: candidate.name,
        provider: candidate.provider,
        reason: duplicateDiscoveredSkillReason,
        scope: candidate.scope,
      })),
  );
  discovery.candidates = discovery.candidates.filter(
    (candidate) => !duplicateNames.has(candidate.name),
  );
}

function sortImportableSkillDiscovery(
  discovery: ImportableSkillDiscovery,
): void {
  discovery.candidates.sort(compareImportableSkillCandidates);
  discovery.conflicts.sort(compareImportSkips);
  discovery.skipped.sort(compareImportSkips);
}

function assertUniqueImportNames(
  skills: readonly ImportableSkillCandidate[],
): void {
  const duplicates = [...duplicateImportCandidateNames(skills)].sort();
  if (duplicates.length > 0) {
    throw new Error(
      `Selected import skills contain duplicate names: ${duplicates.join(", ")}`,
    );
  }
}

function duplicateImportCandidateNames(
  candidates: readonly ImportableSkillCandidate[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );
}

function selectedImportCandidates(
  preview: ImportableSkillDiscovery,
  selectedIds: readonly string[],
): ImportableSkillCandidate[] {
  const candidatesById = new Map(
    preview.candidates.map((candidate) => [candidate.id, candidate]),
  );

  return selectedIds.map((id) => {
    const candidate = candidatesById.get(id);
    if (candidate === undefined) {
      throw new Error(`Selected import skill is not available: ${id}`);
    }

    return candidate;
  });
}

function compareImportableSkillCandidates(
  left: ImportableSkillCandidate,
  right: ImportableSkillCandidate,
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.scope.localeCompare(right.scope) ||
    left.name.localeCompare(right.name)
  );
}

function compareImportSkips(
  left: ImportSkillsSkip,
  right: ImportSkillsSkip,
): number {
  return (
    (left.provider ?? "").localeCompare(right.provider ?? "") ||
    (left.scope ?? "").localeCompare(right.scope ?? "") ||
    left.name.localeCompare(right.name)
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
