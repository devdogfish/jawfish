import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "./errors.ts";

const catalogEntrySchema = z.object({
  type: z.enum(["skill", "agent", "prompt"]),
  description: z.string(),
  path: z.string(),
  upstream: z.string().optional(),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type Catalog = Record<string, CatalogEntry>;

export async function readCatalog(libraryDir: string): Promise<Catalog> {
  const catalogPath = join(libraryDir, "index.json");
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid catalog at ${catalogPath}: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid catalog at ${catalogPath}: expected name-keyed object`);
  }

  const catalog: Catalog = {};
  const issues: string[] = [];

  for (const [name, entry] of Object.entries(parsed)) {
    const result = catalogEntrySchema.safeParse(entry);

    if (result.success) {
      catalog[name] = result.data;
      continue;
    }

    for (const issue of result.error.issues) {
      issues.push(`${name}.${issue.path.join(".")}: ${issue.message}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid catalog at ${catalogPath}: ${issues.join("; ")}`);
  }

  return catalog;
}
