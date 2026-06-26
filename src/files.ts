import { stat } from "node:fs/promises";
import { errorHasCode } from "./errors.ts";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}
