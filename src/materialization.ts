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
import { toolPaths } from "./config.ts";
import { exists } from "./files.ts";
import {
  destinationSpec,
  type AgenticType,
  type DestinationSpec,
  type InstallScope,
} from "./tool-adapters.ts";

const managedMarkerFile = ".jawfish-managed.json";
const nativeMarkerDirectory = ".jawfish-managed";

export interface MaterializationTarget {
  name: string;
  scope: InstallScope;
  tool: string;
  type: AgenticType;
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

type NativeDestination = Extract<DestinationSpec, { kind: "file" }>;

export async function materializeSource(
  sourcePath: string,
  target: MaterializationTarget,
  options: PathOptions = {},
): Promise<void> {
  const destination = destinationForTarget(target, options);
  const sourceFiles = await packageFiles(sourcePath);

  if (destination.kind === "file") {
    await copyNativeFile(destination, sourceFiles, target);
    return;
  }

  if (await canAdoptUnmanagedDestination(destination.path, sourceFiles)) {
    await writeManagedMarker(destination.path, sourceFiles, target);
    return;
  }

  const managedFiles = await managedFileSet(destination.path);

  await assertNoUnmanagedConflicts(destination.path, sourceFiles, managedFiles);
  await mkdir(destination.path, { recursive: true });
  await removeStaleManagedFiles(destination.path, sourceFiles, managedFiles);
  await copyPackageFiles(destination.path, sourceFiles);
  await writeManagedMarker(destination.path, sourceFiles, target);
}

export async function assertCanMaterializeSource(
  sourcePath: string,
  target: MaterializationTarget,
  options: PathOptions = {},
): Promise<void> {
  const destination = destinationForTarget(target, options);
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

export async function adoptMaterializedPackage(
  target: MaterializationTarget,
  options: PathOptions = {},
): Promise<void> {
  const destination = destinationForTarget(target, options);

  if (destination.kind === "file") {
    await assertAdoptableDestinationExists(destination.path, "destination file");
    await writeNativeMarker(destination.path, target);
    return;
  }

  await assertAdoptableDestinationExists(destination.path, "destination");
  await writeManagedMarker(
    destination.path,
    await installedPackageFiles(destination.path),
    target,
  );
}

export async function removeMaterializedPackage(
  target: MaterializationTarget,
  options: PathOptions = {},
): Promise<void> {
  const destination = destinationForTarget(target, options);
  if (destination.kind === "file") {
    await removeManagedNativeFile(destination.path);
    return;
  }

  await removeManagedDestination(destination.path);
}

export async function stripMaterializationMetadata(path: string): Promise<void> {
  if (!(await exists(path))) {
    return;
  }

  const pathStat = await stat(path);
  if (pathStat.isDirectory()) {
    await stripDirectoryMaterializationMetadata(path);
    return;
  }

  await rm(nativeMarkerPath(path), { force: true });
}

export function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const parentRelative = relative(root, resolved);
  if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
    throw new Error(`Path escapes agentics repo: ${path}`);
  }

  return resolved;
}

function destinationForTarget(
  target: MaterializationTarget,
  options: PathOptions,
): DestinationSpec {
  return destinationSpec(
    target.name,
    target.type,
    target.scope,
    target.tool,
    toolPaths(options.env, options.cwd),
  );
}

async function copyNativeFile(
  destination: NativeDestination,
  sourceFiles: PackageFile[],
  target: MaterializationTarget,
): Promise<void> {
  const sourceFile = await assertCanCopyNativeFile(destination, sourceFiles);
  await mkdir(dirname(destination.path), { recursive: true });
  await cp(sourceFile.path, destination.path);
  await writeNativeMarker(destination.path, target);
}

async function assertCanCopyNativeFile(
  destination: NativeDestination,
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

  if (await canAdoptUnmanagedNativeFile(destination.path, sourceFile.path)) {
    return sourceFile;
  }

  await assertNoUnmanagedNativeConflict(destination.path);
  return sourceFile;
}

async function assertAdoptableDestinationExists(
  path: string,
  label: string,
): Promise<void> {
  if (!(await exists(path))) {
    throw new Error(`Cannot adopt missing ${label}: ${path}`);
  }
}

async function assertNoUnmanagedNativeConflict(path: string): Promise<void> {
  if (!(await exists(path)) || (await exists(nativeMarkerPath(path)))) {
    return;
  }

  throw new Error(
    `Refusing to overwrite unmanaged destination file: ${path}\n` +
      "Remove it or move it aside, then retry.",
  );
}

async function assertNoUnmanagedConflicts(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    if (!(await exists(installedPath))) {
      continue;
    }
    if (managedFiles.has(sourceFile.relativePath)) {
      continue;
    }

    throw new Error(
      `Refusing to overwrite unmanaged destination file: ${installedPath}\n` +
        "Remove it or move it aside, then retry.",
    );
  }
}

async function canAdoptUnmanagedDestination(
  destination: string,
  sourceFiles: PackageFile[],
): Promise<boolean> {
  if (!(await exists(destination))) {
    return false;
  }
  if (await exists(managedMarkerPath(destination))) {
    return false;
  }

  return await directoryContainsMatchingPackage(destination, sourceFiles);
}

async function canAdoptUnmanagedNativeFile(
  destination: string,
  sourcePath: string,
): Promise<boolean> {
  if (!(await exists(destination))) {
    return false;
  }
  if (await exists(nativeMarkerPath(destination))) {
    return false;
  }

  return await filesMatch(sourcePath, destination);
}

async function directoryContainsMatchingPackage(
  destination: string,
  sourceFiles: PackageFile[],
): Promise<boolean> {
  for (const sourceFile of sourceFiles) {
    const installedPath = join(destination, sourceFile.relativePath);
    if (!(await exists(installedPath))) {
      return false;
    }
    if (!(await filesMatch(sourceFile.path, installedPath))) {
      return false;
    }
  }

  return true;
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  return (await readFile(left)).equals(await readFile(right));
}

async function writeManagedMarker(
  destination: string,
  sourceFiles: PackageFile[],
  target: MaterializationTarget,
): Promise<void> {
  await writeJson(
    managedMarkerPath(destination),
    managedMarkerContents(
      sourceFiles.map((file) => file.relativePath),
      target,
    ),
  );
}

async function writeNativeMarker(
  destination: string,
  target: MaterializationTarget,
): Promise<void> {
  await writeJson(
    nativeMarkerPath(destination),
    managedMarkerContents([basename(destination)], target),
  );
}

async function removeStaleManagedFiles(
  destination: string,
  sourceFiles: PackageFile[],
  managedFiles: Set<string>,
): Promise<void> {
  const sourceFileNames = new Set(sourceFiles.map((file) => file.relativePath));
  for (const managedFile of managedFiles) {
    if (sourceFileNames.has(managedFile)) {
      continue;
    }

    const installedPath = join(destination, managedFile);
    await rm(installedPath, { force: true });
    await removeEmptyParents(dirname(installedPath), destination);
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

  const markerPath = managedMarkerPath(destination);
  if (!(await exists(markerPath))) {
    throw new Error(
      `Refusing to overwrite unmanaged destination: ${destination}\n` +
        "This destination is not managed by Jawfish.\n" +
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

  const markerPath = managedMarkerPath(destination);
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
  return join(dirname(path), nativeMarkerDirectory, `${basename(path)}.json`);
}

function managedMarkerPath(destination: string): string {
  return join(destination, managedMarkerFile);
}

function managedMarkerContents(
  files: string[],
  target: MaterializationTarget,
): ManagedMarker {
  return {
    files: [...files].sort(),
    name: target.name,
    tool: target.tool,
    type: target.type,
  };
}

async function stripDirectoryMaterializationMetadata(
  path: string,
): Promise<void> {
  await rm(managedMarkerPath(path), { force: true });
  await rm(join(path, nativeMarkerDirectory), {
    force: true,
    recursive: true,
  });
}

async function packageFiles(sourcePath: string): Promise<PackageFile[]> {
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) {
    return [{ path: sourcePath, relativePath: basename(sourcePath) }];
  }

  return directoryFiles(sourcePath, sourcePath);
}

async function installedPackageFiles(destination: string): Promise<PackageFile[]> {
  return (await directoryFiles(destination, destination)).filter(
    (file) => file.relativePath !== managedMarkerFile,
  );
}

async function installedFiles(destination: string): Promise<string[]> {
  return (await installedPackageFiles(destination)).map(
    (file) => file.relativePath,
  );
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

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      path,
      relativePath: relative(root, path),
    });
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
