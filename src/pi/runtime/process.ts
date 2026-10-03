// Copied from TelegramAgent backend/src/runtime-sdk/process.ts (same owner), unchanged.
// Node-only: imported by the Pi host, never by the browser bundle.

type KillableChild = {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once?(event: "exit", listener: () => void): unknown;
};

/**
 * `cleanup` ends a run normally: a leader that already exited on its own is
 * left alone with whatever it deliberately left running. `abort` reaps the
 * whole group even after the leader exited, e.g. on its own after a cancel.
 */
export type ChildProcessTerminationMode = "cleanup" | "abort";

/**
 * Spawn runtime CLIs as POSIX process-group leaders so termination also reaches
 * the shells and tools they start. Windows has no negative-PID group signal.
 */
export const RUNTIME_PROCESS_GROUP = process.platform !== "win32";

function processGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Groups that must not outlive the backend: live runtime leaders and groups
// whose termination is still escalating. The backend's own shutdown grace is
// shorter than the SIGKILL escalation, so reap them synchronously on exit.
const trackedProcessGroups = new Set<number>();
let exitReaperInstalled = false;

function trackProcessGroup(groupId: number): void {
  if (!exitReaperInstalled) {
    exitReaperInstalled = true;
    process.on("exit", reapTrackedProcessGroups);
  }
  trackedProcessGroups.add(groupId);
}

export function reapTrackedProcessGroups(): void {
  for (const groupId of trackedProcessGroups) {
    try {
      process.kill(-groupId, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  trackedProcessGroups.clear();
}

/** Keep only the recent diagnostic tail so a failed driver cannot grow memory without bound. */
export function appendRecentStderr(current: string, chunk: string, maxChars = 4000): string {
  const next = `${current}${chunk}`;
  return next.length > maxChars ? next.slice(next.length - maxChars) : next;
}

/**
 * Escalate a child shutdown only when the process does not honor SIGTERM.
 * With `processGroup`, signals go to the child's whole group, and escalation
 * keeps going while any member lives: the leader often exits on SIGTERM before
 * the tools it started do. Leader exit is read from the child's own `exit`
 * event, not the caller's stdio `close`, which a grandchild holding the
 * inherited stdout can delay indefinitely.
 */
export function createChildProcessTerminator(
  child: KillableChild,
  isExited: () => boolean,
  killDelayMs = 1500,
  options: { processGroup?: boolean } = {},
): (mode?: ChildProcessTerminationMode) => void {
  let killTimer: NodeJS.Timeout | undefined;
  let leaderExited = false;
  const groupId = options.processGroup && RUNTIME_PROCESS_GROUP ? child.pid : undefined;
  if (groupId !== undefined) trackProcessGroup(groupId);
  child.once?.("exit", () => {
    leaderExited = true;
    if (groupId !== undefined && !killTimer) trackedProcessGroups.delete(groupId);
  });
  const exited = () => leaderExited || isExited();
  const send = (signal: NodeJS.Signals) => {
    if (groupId !== undefined) {
      try {
        process.kill(-groupId, signal);
        return;
      } catch {
        // The group is gone; fall back to the direct child below.
      }
    }
    if (!exited()) child.kill(signal);
  };
  const stillRunning = () => groupId !== undefined ? processGroupAlive(groupId) : !exited();
  return (mode = "cleanup") => {
    if (killTimer) return;
    if (exited() && (mode === "cleanup" || groupId === undefined || !processGroupAlive(groupId))) return;
    if (groupId !== undefined) trackProcessGroup(groupId);
    send("SIGTERM");
    killTimer = setTimeout(() => {
      killTimer = undefined;
      if (stillRunning()) send("SIGKILL");
      if (groupId !== undefined && exited()) trackedProcessGroups.delete(groupId);
    }, killDelayMs);
    killTimer.unref();
  };
}
