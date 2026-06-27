import { errorMessage } from "./errors.ts";

export interface BulkUpdateFailure {
  details: string;
  message: string;
  name: string;
}

export interface BulkUpdateSummary {
  failed: BulkUpdateFailure[];
  skipped: string[];
  updated: string[];
}

export type UpdateResult =
  | { kind: "single"; name: string }
  | { kind: "bulk"; summary: BulkUpdateSummary };

export function updatedPackageResult(name: string): UpdateResult {
  return { kind: "single", name };
}

export function bulkUpdateResult(summary: BulkUpdateSummary): UpdateResult {
  return { kind: "bulk", summary };
}

export function updateFailure(
  name: string,
  error: unknown,
): BulkUpdateFailure {
  const details = errorMessage(error);
  return {
    details,
    message: details.split("\n")[0],
    name,
  };
}

export function formatUpdateResult(result: UpdateResult): string {
  if (result.kind === "single") {
    return `Updated ${result.name}`;
  }

  const { summary } = result;
  return [
    `Updated: ${formatSummaryNames(summary.updated)}`,
    `Skipped: ${formatSummaryNames(summary.skipped)}`,
    `Failed: ${formatBulkUpdateFailures(summary.failed)}`,
  ].join("\n");
}

export function formatUpdateDiagnostics(result: UpdateResult): string {
  if (result.kind === "single") {
    return "";
  }

  return result.summary.failed
    .map((failure) => `Failed to update ${failure.name}:\n${failure.details}`)
    .join("\n");
}

export function updateResultExitCode(result: UpdateResult): number {
  return result.kind === "bulk" && result.summary.failed.length > 0 ? 1 : 0;
}

function formatSummaryNames(names: string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function formatBulkUpdateFailures(failures: BulkUpdateFailure[]): string {
  if (failures.length === 0) {
    return "none";
  }

  return failures
    .map((failure) => `${failure.name} (${failure.message})`)
    .join(", ");
}
