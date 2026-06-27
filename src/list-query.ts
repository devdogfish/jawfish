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
  const entries = Object.entries(query.catalog.jawfish)
    .filter(([, entry]) => query.type === undefined || entry.type === query.type)
    .map(([name, entry]) => ({
      description: entry.description,
      installed: installedStatus(
        name,
        query.projectManifest,
        query.globalManifest,
      ),
      name,
      path: compactHomePath(resolveInside(query.agenticsRepoDir, entry.path)),
      type: entry.type,
    }))
    .filter(
      (entry) =>
        query.installed === undefined ||
        matchesInstalledFilter(entry.installed, query.installed),
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
