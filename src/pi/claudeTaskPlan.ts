import type { AgentUXEvent } from "@agent-ux/protocol";
import { taskPlanSnapshot, type PlanStep } from "../runtime/taskPlan.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const identifiedSteps = (value: unknown) => {
  const steps = taskPlanSnapshot("", value)?.steps;
  return steps?.every((step) => step.taskId) && new Set(steps.map((step) => step.taskId)).size === steps.length ? steps : undefined;
};

/** Restore only the latest plan, and only when it carries native Claude task identities. */
export function lastClaudeTaskPlan(events: readonly AgentUXEvent[]): PlanStep[] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== "artifact.delta") continue;
    const data = record(event.payload.delta);
    if (data.kind === "task-plan") return identifiedSteps(data.steps);
  }
}

/** Native task files own execution state; this bounded projection owns only the displayed snapshot. */
export function createClaudeTaskPlan(initialPlan?: unknown) {
  let steps = identifiedSteps(initialPlan) ?? [];
  const fromTask = (value: unknown, partial = false) => {
    const task = record(value);
    // TaskGet omits owner; TaskList is the authoritative assignment snapshot.
    return { ...(partial ? steps.find(step => step.taskId === task.id) : {}),
      taskId: task.id, step: task.subject, status: task.status,
      ...(!partial || "owner" in task ? { owner: task.owner } : {}),
      ...("blockedBy" in task ? { blockedBy: task.blockedBy, dependenciesPending: undefined } : {}) };
  };
  return (name: string, args: Record<string, unknown>, result: unknown): PlanStep[] | undefined => {
    const receipt = record(result);
    let next: unknown;
    if (name === "TaskList" && Array.isArray(receipt.tasks)) {
      next = receipt.tasks.map(task => fromTask(task));
    } else if ((name === "TaskCreate" || name === "TaskGet") && receipt.task) {
      const task = fromTask(receipt.task, name === "TaskGet");
      if (name === "TaskCreate") task.status = "pending";
      next = steps.some((step) => step.taskId === task.taskId)
        ? steps.map((step) => step.taskId === task.taskId ? task : step) : [...steps, task];
    } else if (name === "TaskUpdate" && receipt.success === true && receipt.taskId === args.taskId) {
      const fields = Array.isArray(receipt.updatedFields) ? receipt.updatedFields : [];
      const status = record(receipt.statusChange).to;
      if (fields.includes("deleted") && status === "deleted") {
        next = steps.filter((step) => step.taskId !== receipt.taskId)
          .map(step => ({ ...step, blockedBy: step.blockedBy?.filter(id => id !== receipt.taskId) }));
      } else {
        if (!steps.some((step) => step.taskId === receipt.taskId)) return;
        const added = fields.includes("blockedBy") ? args.addBlockedBy : [];
        const blocks = fields.includes("blocks") ? args.addBlocks : [];
        if (!Array.isArray(added) || !Array.isArray(blocks) || added.length > 100 || blocks.length > 100 ||
          [...added, ...blocks].some(id => typeof id !== "string" || !id.trim() || id.length > 160)) return;
        if (fields.includes("owner") && typeof args.owner !== "string") return;
        const known = new Set(steps.map(step => step.taskId));
        next = steps.map((step) => step.taskId !== receipt.taskId ? {
          ...step, ...(blocks.includes(step.taskId) ? { blockedBy: [...new Set([...(step.blockedBy ?? []), receipt.taskId])] } : {}),
        } : {
          ...step, ...(fields.includes("subject") ? { step: args.subject } : {}),
          ...(fields.includes("status") ? { status } : {}), ...(fields.includes("owner") ? { owner: args.owner } : {}),
          blockedBy: [...new Set([...(step.blockedBy ?? []), ...added.filter(id => known.has(id)), ...(blocks.includes(step.taskId) ? [receipt.taskId] : [])])],
          // Native updates silently skip missing ids. A partial projection cannot certify them.
          dependenciesPending: step.dependenciesPending || added.some(id => !known.has(id)),
        });
      }
    } else return;
    const validated = identifiedSteps(next);
    if (!validated) return;
    steps = validated;
    return steps;
  };
}
