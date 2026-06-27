import { type ListResult, type ListResultEntry } from "./list-query.ts";

const listColumns = [
  "name",
  "type",
  "installed",
  "description",
] as const satisfies readonly (keyof ListResultEntry)[];

export function formatListRawJson(result: ListResult): string {
  return JSON.stringify(result.entries, null, 2);
}

export function formatListTable(result: ListResult): string {
  const widths = listColumnWidths(result.entries);
  const top = tableBorder("┌", "┬", "┐", widths);
  const middle = tableBorder("├", "┼", "┤", widths);
  const bottom = tableBorder("└", "┴", "┘", widths);
  const header = tableRow(listColumns, widths);
  const rows = result.entries.map((entry) =>
    tableRow(listRowValues(entry), widths),
  );

  return [top, header, middle, ...rows, bottom].join("\n");
}

function listColumnWidths(entries: readonly ListResultEntry[]): number[] {
  return listColumns.map((column) =>
    Math.max(
      column.length,
      ...entries.map((entry) => String(entry[column]).length),
    ),
  );
}

function listRowValues(entry: ListResultEntry): string[] {
  return listColumns.map((column) => String(entry[column]));
}

function tableBorder(
  left: string,
  joiner: string,
  right: string,
  widths: readonly number[],
): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(joiner)}${right}`;
}

function tableRow(values: readonly string[], widths: readonly number[]): string {
  return `│ ${values
    .map((value, index) => value.padEnd(widths[index]))
    .join(" │ ")} │`;
}
