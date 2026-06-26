import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "./errors.ts";
import { exists } from "./files.ts";
import { type AgenticType } from "./tool-adapters.ts";

export const catalogFile = "catalog.json";
export const indexCatalogFile = "index.json";
export const agenticTypes = [
  "skill",
  "agent",
  "prompt",
] as const satisfies readonly AgenticType[];

export interface Catalog {
  jawfish: Record<string, CatalogEntry>;
}

export interface CatalogEntry {
  description: string;
  path: string;
  type: AgenticType;
  upstream?: string;
}

export interface RawCatalogEntries {
  entries: Record<string, unknown>;
  path?: string;
}

export async function readCatalog(agenticsRepoDir: string): Promise<Catalog> {
  const raw = await readRawCatalog(agenticsRepoDir);
  if (raw.path === undefined) {
    return { jawfish: {} };
  }

  return validateCatalog(raw.path, {
    jawfish: raw.entries as Record<string, CatalogEntry>,
  });
}

export async function readRawCatalog(
  agenticsRepoDir: string,
): Promise<RawCatalogEntries> {
  const indexPath = join(agenticsRepoDir, indexCatalogFile);
  if (await exists(indexPath)) {
    const parsed = await readJson(indexPath);
    if (!isRecord(parsed)) {
      throw new Error(
        `Invalid catalog at ${indexPath}: expected name-keyed object`,
      );
    }

    return { entries: parsed, path: indexPath };
  }

  const legacyPath = join(agenticsRepoDir, catalogFile);
  if (await exists(legacyPath)) {
    const parsed = await readJson(legacyPath);
    if (!isRecord(parsed)) {
      throw new Error(`Invalid catalog at ${legacyPath}: expected object`);
    }
    if (parsed.jawfish !== undefined && !isRecord(parsed.jawfish)) {
      throw new Error(
        `Invalid catalog at ${legacyPath}: jawfish must be an object`,
      );
    }

    return { entries: parsed.jawfish ?? {}, path: legacyPath };
  }

  return { entries: {} };
}

export async function writeCatalog(
  agenticsRepoDir: string,
  catalog: Catalog,
): Promise<void> {
  await writeJson(join(agenticsRepoDir, indexCatalogFile), catalog.jawfish);
  await rm(join(agenticsRepoDir, catalogFile), { force: true });
}

export function validateCatalog(path: string, catalog: Catalog): Catalog {
  const issues: string[] = [];

  for (const [name, entry] of Object.entries(catalog.jawfish)) {
    issues.push(...catalogEntryIssues(name, entry));
  }

  if (issues.length > 0) {
    throw new Error(`Invalid catalog at ${path}: ${issues.join("; ")}`);
  }

  return catalog;
}

export function catalogEntryIssues(name: string, entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${name}: expected object`];
  }

  const issues: string[] = [];

  if (!("description" in entry) || typeof entry.description !== "string") {
    issues.push(`${name}.description`);
  }

  if (!("path" in entry) || typeof entry.path !== "string") {
    issues.push(`${name}.path`);
  }

  if (!("type" in entry) || !isAgenticType(entry.type)) {
    issues.push(`${name}.type`);
  }

  if ("upstream" in entry && typeof entry.upstream !== "string") {
    issues.push(`${name}.upstream`);
  }

  return issues;
}

export function isAgenticType(value: unknown): value is AgenticType {
  return (
    value === "skill" ||
    value === "agent" ||
    value === "prompt"
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid catalog at ${path}: ${errorMessage(error)}`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
