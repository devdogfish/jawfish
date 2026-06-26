import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { manifestPath, toolPaths } from "./config.ts";
import { exists } from "./files.ts";
import {
  destinationSpec,
  type AgenticType,
  type DestinationSpec,
  type InstallScope,
} from "./tool-adapters.ts";
import { type Catalog } from "./catalog.ts";

export const managedMarkerFile = ".jawfish-managed.json";

export interface Manifest {
  jawfish: Record<string, ManifestEntry>;
}

export interface ManifestEntry {
  tool: string;
}

interface ManagedMarker {
  files?: string[];
  name: string;
  tool: string;
  type: AgenticType;
}

interface PackageFile {
  path: string;
  relativePath: string;
}

interface PathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function readManifest(
  scope: InstallScope,
  options: PathOptions = {},
): Promise<Manifest> {
  const path = manifestPath(scope, options.env, options.cwd);
  if (!(await exists(path))) {
    return { jawfish: {} };
  }

  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Manifest>;
  return { jawfish: parsed.jawfish ?? {} };
}

export async function writeManifest(
  scope: InstallScope,
  manifest: Manifest,
  options: PathOptions = {},
): Promise<void> {
  await writeJson(manifestPath(scope, options.env, options.cwd), manifest);
}

export async function installManifestEntry(
  agenticsRepoDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  tool: string,
  options: PathOptions = {},
): Promise<void> {
  await materialize(agenticsRepoDir, catalog, name, scope, tool, options);

  const manifest = await readManifest(scope, options);
  manifest.jawfish[name] = { tool };
  await writeManifest(scope, manifest, options);
}

export async function materialize(
  agenticsRepoDir: string,
  catalog: Catalog,
  name: string,
  scope: InstallScope,
  tool: string,
  options: PathOptions = {},
): Promise<void> {
  const entry = catalog.jawfish[name];
  if (entry === undefined) {
    throw new Error(`Unknown agentic: ${name}`);
  }

  const sourcePath = resolveInside(agenticsRepoDir, entry.path);
  await materializePackage(sourcePath, name, entry.type, scope, tool, options);
}

export async function removeMaterialized(
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
  options: PathOptions = {},
): Promise<void> {
  const destination = destinationSpec(
    name,
    type,
    scope,
    tool,
    toolPaths(options.env, options.cwd),
  );
  if (destination.kind === "file") {
    await removeManagedNativeFile(destination.path);
    return;
  }

  await removeManagedDestination(destination.path);
}

export async function assertCanMaterializePackage(
  sourcePath: string,
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
  options: PathOptions = {},
): Promise<void> {
  const destination = destinationSpec(
    name,
    type,
    scope,
    tool,
    toolPaths(options.env, options.cwd),
  );
  const sourceFiles = await packageFiles(sourcePath);

  if (destination.kind === "file") {
    await assertCanCopyNativeFile(destination, sourceFiles);
    return;
  }

  const managedFiles = await managedFileSet(destination.path);
  await assertNoUnmanagedConflicts(
    destination.path,
    sourceFiles,
    managedFiles,
  );
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const parentRelative = relative(root, resolved);
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new Error(`Path escapes agentics repo: ${path}`);
  }

  return resolved;
}

async function materializePackage(
  sourcePath: string,
  name: string,
  type: AgenticType,
  scope: InstallScope,
  tool: string,
  options: PathOptions,
): Promise<void> {
  const destination = destinationSpec(
    name,
    type,
    scope,
    tool,
    toolPaths(options.env, options.cwd),
  );
  const sourceFiles = await packageFiles(sourcePath);

  if (destination.kind === "file") {
    await copyNativeFile(destination, sourceFiles, name, tool, type);
    return;
  }

  const managedFiles = await managedFileSet(destination.path);

  await assertNoUnmanagedConflicts(destination.path, sourceFiles, managedFiles);
  await mkdir(destination.path, { recursive: true });
  await removeStaleManagedFiles(destination.path, sourceFiles, managedFiles);
  await copyPackageFiles(destination.path, sourceFiles);

  await writeJson(join(destination.path, managedMarkerFile), {
    files: sourceFiles.map((file) => file.relativePath).sort(),
    name,
    tool,
    type,
  });
}

async function copyNativeFile(
  destination: Extract<DestinationSpec, { kind: "file" }>,
  sourceFiles: PackageFile[],
  name: string,
  tool: string,
  type: AgenticType,
): Promise<void> {
  const sourceFile = await assertCanCopyNativeFile(destination, sourceFiles);
  await mkdir(dirname(destination.path), { recursive: true });
  await cp(sourceFile.path, destination.path);
  await writeJson(nativeMarkerPath(destination.path), {
    files: [basename(destination.path)],
    name,
    tool,
    type,
  });
}

async function assertCanCopyNativeFile(
  destination: Extract<DestinationSpec, { kind: "file" }>,
  sourceFiles: PackageFile[],
): Promise<PackageFile> {
  if (sourceFiles.length !== 1) {
    throw new Error(
      `Native ${destination.extension} destinations require exactly one source file: ${destination.path}`,
    );
  }

  const [sourceFile] = sourceFiles;
  if (
    sourceFile === undefined ||
    extname(sourceFile.path) !== destination.extension
  ) {
    throw new Error(
      `Native destination requires a ${destination.extension} source file: ${sourceFile?.path ?? ""}`,
    );
  }

  await assertNoUnmanagedNativeConflict(destination.path);
  return sourceFile;
}

async function assertNoUnmanagedNativeConflict(path: string): Promise<void> {
  if ((await exists(path)) && !(await exists(nativeMarkerPath(path)))) {
    throw new Error(
      `Refusing to overwrite unmanaged destination file: ${path}\n` +
        "Remove it or move it aside, then retry.",
    );
  }
}

async function assertNoUnmanagedConflicts(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    if (
      (await exists(installedPath)) &&
      !managedFiles.has(sourceFile.relativePath)
    ) {
      throw new Error(
        `Refusing to overwrite unmanaged destination file: ${installedPath}\n` +
          "Remove it or move it aside, then retry.",
      );
    }
  }
}

async function removeStaleManagedFiles(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  const sourceFileNames = new Set(sourceFiles.map((file) => file.relativePath));
  for (const managedFile of managedFiles) {
    if (!sourceFileNames.has(managedFile)) {
      const installedPath = join(destination, managedFile);
      await rm(installedPath, { force: true });
      await removeEmptyParents(dirname(installedPath), destination);
    }
  }
}

async function copyPackageFiles(
  destination: string,
  sourceFiles: PackageFile[],
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    await mkdir(dirname(installedPath), { recursive: true });
    await cp(sourceFile.path, installedPath);
  }
}

async function managedFileSet(destination: string): Promise<Set<string>> {
  if (!(await exists(destination))) {
    return new Set();
  }

  const markerPath = join(destination, managedMarkerFile);
  if (!(await exists(markerPath))) {
    throw new Error(
      `Refusing to overwrite unmanaged destination: ${destination}\n` +
        "Remove it or move it aside, then retry.",
    );
  }

  const marker = JSON.parse(
    await readFile(markerPath, "utf8"),
  ) as ManagedMarker;
  if (Array.isArray(marker.files)) {
    return new Set(marker.files);
  }

  return new Set(await installedFiles(destination));
}

async function removeManagedDestination(destination: string): Promise<void> {
  if (!(await exists(destination))) {
    return;
  }

  const markerPath = join(destination, managedMarkerFile);
  if (!(await exists(markerPath))) {
    return;
  }

  for (const managedFile of await managedFileSet(destination)) {
    const installedPath = join(destination, managedFile);
    await rm(installedPath, { force: true });
    await removeEmptyParents(dirname(installedPath), destination);
  }

  await rm(markerPath, { force: true });
  await removeEmptyParents(destination, destination);
}

async function removeManagedNativeFile(path: string): Promise<void> {
  const markerPath = nativeMarkerPath(path);
  if (!(await exists(markerPath))) {
    return;
  }

  await rm(path, { force: true });
  await rm(markerPath, { force: true });
  await removeEmptyParents(dirname(markerPath), dirname(dirname(markerPath)));
}

function nativeMarkerPath(path: string): string {
  return join(dirname(path), ".jawfish-managed", `${basename(path)}.json`);
}

async function packageFiles(sourcePath: string): Promise<PackageFile[]> {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    return [{ path: sourcePath, relativePath: basename(sourcePath) }];
  }

  return directoryFiles(sourcePath, sourcePath);
}

export async function installedFiles(destination: string): Promise<string[]> {
  return (await directoryFiles(destination, destination))
    .map((file) => file.relativePath)
    .filter((file) => file !== managedMarkerFile);
}

async function directoryFiles(
  root: string,
  current: string,
): Promise<PackageFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: PackageFile[] = [];

  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await directoryFiles(root, path)));
      continue;
    }

    if (entry.isFile()) {
      files.push({
        path,
        relativePath: relative(root, path),
      });
    }
  }

  return files;
}

async function removeEmptyParents(start: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  let current = resolve(start);

  while (current === resolvedRoot || current.startsWith(`${resolvedRoot}/`)) {
    if (!(await exists(current))) {
      current = dirname(current);
      continue;
    }

    if ((await readdir(current)).length > 0) {
      return;
    }

    await rm(current, { force: true, recursive: true });
    if (current === resolvedRoot) {
      return;
    }

    current = dirname(current);
  }
}
