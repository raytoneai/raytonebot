import { randomUUID } from "node:crypto";
import type { AgentUXEvent } from "@agent-ux/protocol";

export type GroupTask = {
  id: string; parentId?: string; retryOf?: string; reviewedAt?: number; requestId: string; owner: string; title: string;
  status: "pending" | "running" | "completed" | "cancelled" | "failed" | "needs_review";
  runId?: string; result?: string; resultTruncated?: boolean; updatedAt: number;
  /** A one-layer read-only delegate owns a fresh hidden conversation. */
  kind?: "delegation"; conversationId?: string; notifiedAt?: number;
};
export function newGroupTask(requestId: string, owner: string, title: string, parentId?: string): GroupTask {
  return { id: `assignment_${randomUUID()}`, requestId, owner, title: title.slice(0, 500), status: "pending", updatedAt: Date.now(), ...(parentId ? { parentId } : {}) };
}
/** Keep unresolved work, plus the ten most recent finished roots and their children. */
export function retainedGroupTasks(tasks: GroupTask[] = []): GroupTask[] {
  const roots = tasks.filter(t => !t.parentId);
  const keep = new Set([...tasks.filter(t => ["pending", "running", "needs_review"].includes(t.status) || t.kind === "delegation" && !t.notifiedAt).map(t => t.parentId ?? t.id), ...roots.slice(-10).map(t => t.id)]);
  return tasks.filter(t => keep.has(t.parentId ?? t.id));
}
export function settleGroupTask(task: GroupTask, runId: string, status: GroupTask["status"], result?: string): GroupTask {
  if (task.status !== "running" || task.runId !== runId) throw new Error("Stale assignment result refused.");
  return { ...task, status, ...(result ? { result: result.slice(0, 2000), ...(result.length > 2000 ? { resultTruncated: true } : {}) } : {}), updatedAt: Date.now() };
}
export function recoverGroupTasks(tasks: GroupTask[] = [], activeIds: ReadonlySet<string> = new Set()): GroupTask[] {
  return tasks.map(t => !activeIds.has(t.id) && ["pending", "running"].includes(t.status) ? { ...t, status: "needs_review", updatedAt: Date.now() } : t);
}
/** A foreground turn owns its assignments; background delegates own their latest records. */
export function mergeForegroundGroupTasks(current: GroupTask[] = [], foreground: GroupTask[] = []): GroupTask[] {
  const tasks = new Map(current.map(task => [task.id, task]));
  for (const task of foreground) if (task.kind !== "delegation" || !tasks.has(task.id)) tasks.set(task.id, task);
  return retainedGroupTasks([...tasks.values()]);
}
export function groupTaskContext(tasks: GroupTask[]): string {
  return JSON.stringify([...tasks.filter(t => t.status === "needs_review"), ...tasks.filter(t => t.status !== "needs_review").slice(-20)].slice(0, 30).map(({ id, parentId, requestId, owner, title, status, runId, result, resultTruncated, kind }) => ({ id, parentId, requestId, owner, title, status, runId, result, resultTruncated, kind })));
}
/** A full data snapshot; the existing plan renderer supplies Markdown and no new panel. */
export function groupTaskEvents(runId: string, tasks: GroupTask[]): AgentUXEvent[] {
  const artifactId = `plan_group_${runId}`;
  const meta = { runId, ts: Date.now() };
  return [
    { ...meta, type: "artifact.created", payload: { artifactId, kind: "json", title: "Group assignments", mimeType: "application/json" } },
    { ...meta, type: "artifact.delta", payload: { artifactId, format: "json", delta: { kind: "group-tasks", tasks } } },
    { ...meta, type: "artifact.finished", payload: { artifactId, status: "success" } },
  ].map(event => ({ ...event, id: `tasks_${randomUUID()}` })) as AgentUXEvent[];
}

/** Group write turns share one lease. Waiting is cancellable and never starts stopped work. */
export function createGroupWriteQueue() {
  let tail = Promise.resolve();
  return async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    const before = tail;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    tail = before.then(() => held);
    let cancel = () => {};
    try {
      signal.throwIfAborted();
      await Promise.race([before, new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true });
      })]);
      signal.throwIfAborted();
      return await run();
    } finally { signal.removeEventListener("abort", cancel); release(); }
  };
}

/** A retry of a retry still uses the original request, not the slash-command receipt. */
export function originalGroupTaskRequest(tasks: GroupTask[], task: GroupTask): string {
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(task.id)) throw new Error("Invalid assignment retry chain.");
    seen.add(task.id);
    const root = task.parentId ? tasks.find(t => t.id === task.parentId) : task;
    const retryOf = task.retryOf ?? root?.retryOf;
    if (!retryOf) return task.requestId;
    const previous = tasks.find(t => t.id === retryOf);
    if (!previous) throw new Error("Original assignment is no longer available; start a new explicit task.");
    task = previous;
  }
}
