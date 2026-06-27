import { type ListResult, type ListResultEntry } from "./list-query.ts";

export function formatListRawJson(result: ListResult): string {
  return JSON.stringify(result.entries, null, 2);
}

export function formatListTable(result: ListResult): string {
  const columns = ["name", "type", "installed", "description"] as const;
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...result.entries.map((entry) => String(entry[column]).length),
    ),
  );
  const top = tableBorder("┌", "┬", "┐", widths);
  const middle = tableBorder("├", "┼", "┤", widths);
  const bottom = tableBorder("└", "┴", "┘", widths);
  const header = tableRow([...columns], widths);
  const rows = result.entries.map((entry) =>
    tableRow(listRowValues(entry), widths),
  );

  return [top, header, middle, ...rows, bottom].join("\n");
}

function listRowValues(entry: ListResultEntry): string[] {
  return [entry.name, entry.type, entry.installed, entry.description];
}

function tableBorder(
  left: string,
  joiner: string,
  right: string,
  widths: number[],
): string {
  return `${left}${widths.map((width) => "─".repeat(width + 2)).join(joiner)}${right}`;
}

function tableRow(values: string[], widths: number[]): string {
  return `│ ${values
    .map((value, index) => value.padEnd(widths[index]))
    .join(" │ ")} │`;
}
