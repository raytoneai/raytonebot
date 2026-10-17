import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** Only a missing file means first use; unreadable data must never become an empty writable store. */
export function readSettingsFile<T>(file: string | undefined, valid: (data: T) => boolean): { data?: T; error?: Error } {
  if (!file) return {};
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as T;
    if (!data || typeof data !== "object" || Array.isArray(data) || !valid(data)) throw new Error("Invalid settings");
    return { data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { error: new Error(`${basename(file)} could not be read. Its original file has not been changed. Repair it and restart the host before saving.`) };
  }
}
