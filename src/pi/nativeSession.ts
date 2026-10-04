import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type * as Pi from "@earendil-works/pi-coding-agent";

export const MISSING_NATIVE_SESSION = "Saved engine context is unavailable. Restore the native session data or start a new conversation. This request was not retried.";

/** Validate before the SDK opens a file: its recovery parser can skip malformed JSONL lines. */
export function assertPiSessionFile(file: string | undefined, id?: string): void {
  try {
    if (!file) throw new Error();
    const entries = readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string" || (id && header.id !== id)
      || !entries.some(entry => entry?.type === "message" && ["user", "assistant"].includes(entry.message?.role))) throw new Error();
  } catch { throw new Error(MISSING_NATIVE_SESSION); }
}

export async function openPiSession(pi: typeof Pi, input: {
  cwd: string; sessionDir?: string; sessionId?: string | null; hasHistory: boolean;
  branch?: { sessionDir: string; sessionId: string; entryId: string };
}): Promise<Pi.SessionManager> {
  if (!input.sessionDir) return pi.SessionManager.inMemory(input.cwd);
  if (input.branch && input.sessionId === null) {
    const original = await openPiSession(pi, { cwd: input.cwd, sessionDir: input.branch.sessionDir, sessionId: input.branch.sessionId, hasHistory: true });
    // Earlier configuration failures can leave a cutoff containing only setup entries.
    if (!original.getBranch(input.branch.entryId).some(entry => entry.type === "message"
      && ["user", "assistant"].includes(entry.message.role))) throw new Error(MISSING_NATIVE_SESSION);
    const child = pi.SessionManager.open(original.getSessionFile()!, input.sessionDir);
    child.createBranchedSession(input.branch.entryId);
    return child;
  }
  // null means a new product conversation whose prompt has not passed SDK preflight yet.
  // undefined is legacy data: adopt an existing native file, but never manufacture lost context.
  if (input.sessionId === null || (!input.sessionId && !input.hasHistory)) {
    return pi.SessionManager.create(input.cwd, input.sessionDir);
  }
  let file: string | undefined;
  if (input.sessionId) file = pi.SessionManager.findById(input.cwd, input.sessionId, input.sessionDir);
  else {
    // Legacy data has no exact binding. Do not silently skip a damaged file for an older one.
    try {
      for (const name of readdirSync(input.sessionDir)) {
        if (name.endsWith(".jsonl")) assertPiSessionFile(join(input.sessionDir, name));
      }
      file = (await pi.SessionManager.list(input.cwd, input.sessionDir))[0]?.path;
    } catch { throw new Error(MISSING_NATIVE_SESSION); }
  }
  assertPiSessionFile(file, input.sessionId ?? undefined);
  return pi.SessionManager.open(file!, input.sessionDir);
}
