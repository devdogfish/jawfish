import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type Catalog } from "./catalog.ts";
import { type InstalledFilter } from "./command-grammar.ts";
import { type Manifest, resolveInside } from "./install.ts";
import { type AgenticType } from "./tool-adapters.ts";

export interface ListQuery {
  agenticsRepoDir: string;
  catalog: Catalog;
  globalManifest: Manifest;
  installed?: InstalledFilter;
  projectManifest: Manifest;
  type?: AgenticType;
}

export interface ListResult {
  entries: ListResultEntry[];
}

export interface ListResultEntry {
  description: string;
  installed: InstalledStatus;
  name: string;
  path: string;
  type: AgenticType;
}

export type InstalledStatus = "project" | "global" | "both" | "-";

export function queryListCatalog(query: ListQuery): ListResult {
  const {
    agenticsRepoDir,
    catalog,
    globalManifest,
    installed: installedFilter,
    projectManifest,
    type: typeFilter,
  } = query;
  const entries = Object.entries(catalog.jawfish)
    .filter(
      ([, catalogEntry]) =>
        typeFilter === undefined || catalogEntry.type === typeFilter,
    )
    .map(([name, catalogEntry]) => ({
      description: catalogEntry.description,
      installed: installedStatus(
        name,
        projectManifest,
        globalManifest,
      ),
      name,
      path: compactHomePath(resolveInside(agenticsRepoDir, catalogEntry.path)),
      type: catalogEntry.type,
    }))
    .filter(
      (entry) =>
        installedFilter === undefined ||
        matchesInstalledFilter(entry.installed, installedFilter),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  return { entries };
}

export function matchesInstalledFilter(
  status: InstalledStatus,
  filter: InstalledFilter,
): boolean {
  switch (filter) {
    case "project":
      return status === "project" || status === "both";
    case "global":
      return status === "global" || status === "both";
    case "both":
      return status === "both";
    case "none":
      return status === "-";
    case "any":
      return status !== "-";
  }
}

function installedStatus(
  name: string,
  projectManifest: Manifest,
  globalManifest: Manifest,
): InstalledStatus {
  const project = projectManifest.jawfish[name] !== undefined;
  const global = globalManifest.jawfish[name] !== undefined;

  if (project && global) {
    return "both";
  }

  if (project) {
    return "project";
  }

  if (global) {
    return "global";
  }

  return "-";
}

function compactHomePath(path: string): string {
  const home = resolve(homedir());
  const resolved = resolve(path);
  const pathRelativeToHome = relative(home, resolved);

  if (pathRelativeToHome === "") {
    return "~";
  }

  if (
    !pathRelativeToHome.startsWith("..") &&
    !isAbsolute(pathRelativeToHome)
  ) {
    return join("~", pathRelativeToHome);
  }

  return resolved;
}
