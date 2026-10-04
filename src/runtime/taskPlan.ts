import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AgentUXViewModel } from "@agent-ux/render-core";
import type { AppLocale } from "../i18n/locales.ts";

export type PlanStep = { step: string; status: "pending" | "in_progress" | "completed"; taskId?: string;
  owner?: string; blockedBy?: string[]; dependenciesPending?: boolean };
type TaskPlan = { kind: "task-plan"; runId: string; steps: PlanStep[]; explanation?: string };

/** Only complete, bounded snapshots replace the previous plan. Never infer completion. */
export function taskPlanSnapshot(runId: string, plan: unknown, explanation?: unknown): TaskPlan | undefined {
  if (!Array.isArray(plan) || plan.length > 100) return;
  const steps: PlanStep[] = [];
  for (const entry of plan) {
    if (!entry || typeof entry !== "object") return;
    const { step, status: rawStatus, taskId, owner, blockedBy, dependenciesPending } = entry;
    const status = rawStatus === "inProgress" ? "in_progress" : rawStatus;
    if (typeof step !== "string" || !step.trim() || step.length > 4000 ||
      (status !== "pending" && status !== "in_progress" && status !== "completed")) return;
    if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim() || taskId.length > 160)) return;
    if (owner !== undefined && (typeof owner !== "string" || owner.length > 160)) return;
    if (blockedBy !== undefined && (!Array.isArray(blockedBy) || blockedBy.length > 100 ||
      blockedBy.some(id => typeof id !== "string" || !id.trim() || id.length > 160))) return;
    if (dependenciesPending !== undefined && typeof dependenciesPending !== "boolean") return;
    steps.push({ step, status, ...(taskId !== undefined ? { taskId } : {}), ...(owner ? { owner } : {}),
      ...(blockedBy?.length ? { blockedBy: [...new Set<string>(blockedBy)] } : {}), ...(dependenciesPending ? { dependenciesPending } : {}) });
  }
  return { kind: "task-plan", runId, steps,
    ...(typeof explanation === "string" && explanation ? { explanation: explanation.slice(0, 8000) } : {}) };
}

const labels = {
  en: { title: "Plan", completed: "Completed", pending: "Pending", in_progress: "In progress", unfinished: "Unfinished", running: "Run in progress", success: "Run ended", cancelled: "Run stopped", error: "Run failed", empty: "No steps" },
  zh: { title: "计划", completed: "已完成", pending: "待开始", in_progress: "进行中", unfinished: "未完成", running: "本轮运行中", success: "本轮已结束", cancelled: "本轮已停止", error: "本轮失败", empty: "暂无步骤" },
  ja: { title: "計画", completed: "完了", pending: "未着手", in_progress: "進行中", unfinished: "未完了", running: "実行中", success: "実行終了", cancelled: "実行停止", error: "実行失敗", empty: "ステップなし" },
} satisfies Record<AppLocale, Record<string, string>>;

// Keep each step on one list row; inline syntax uses the existing Markdown renderer.
const singleLine = (text: string) => text.replace(/[\r\n]+/g, " ");
const literal = (text: string) => singleLine(text).replace(/[\\`*_[\]<>]/g, "\\$&");
const details = {
  en: { owner: "Owner", waiting: "Waiting for", pending: "Dependencies awaiting confirmation" },
  zh: { owner: "负责人", waiting: "等待前置任务", pending: "依赖变更待核对" },
  ja: { owner: "担当", waiting: "先行タスク待ち", pending: "依存関係の変更を確認待ち" },
};

/** Adapt stored data to the existing Markdown artifact view, including restart/stop events. */
export function displayTaskPlans(view: AgentUXViewModel, events: readonly AgentUXEvent[], locale: string): AgentUXViewModel {
  const endings = new Map<string, "success" | "cancelled" | "error">();
  for (const event of events) {
    if (!event.runId) continue;
    if (event.type === "run.error") endings.set(event.runId, "error");
    else if (event.type === "run.finished") endings.set(event.runId, event.payload.status === "cancelled" ? "cancelled" : event.payload.status === "error" ? "error" : "success");
  }
  const c = labels[locale as keyof typeof labels] ?? labels.en;
  const d = details[locale as keyof typeof details] ?? details.en;
  return { ...view, timeline: view.timeline.map((item) => {
    if (item.kind !== "artifact" || !item.data || typeof item.data !== "object") return item;
    const data = item.data as Record<string, unknown>;
    if (data.kind !== "task-plan" || typeof data.runId !== "string") return item;
    const plan = taskPlanSnapshot(data.runId, data.steps, data.explanation);
    if (!plan) return item;
    const ending = endings.get(plan.runId);
    const count = `${plan.steps.filter((step) => step.status === "completed").length}／${plan.steps.length}`;
    const content = [`# ${c.title}`, `${c.completed} ${count} · ${c[ending ?? "running"]}`,
      ...(plan.explanation ? [singleLine(plan.explanation)] : []),
      plan.steps.map(({ step, status, taskId, owner, blockedBy, dependenciesPending }) => {
        const waiting = (blockedBy ?? []).filter(id => plan.steps.find(task => task.taskId === id)?.status !== "completed");
        const metadata = [owner && `${d.owner}：${literal(owner)}`,
          status !== "completed" && waiting.length && `${d.waiting}：${waiting.map(id => `#${literal(id)}`).join(", ")}`,
          dependenciesPending && d.pending].filter(Boolean);
        return `- **${ending && status === "in_progress" ? c.unfinished : c[status]}** — ${taskId ? `#${literal(taskId)} ` : ""}${singleLine(step)}${metadata.length ? `（${metadata.join(" · ")}）` : ""}`;
      }).join("\n") || c.empty,
    ].join("\n\n");
    return { ...item, artifactKind: "markdown", title: `${c.title} ${count}.md`, content, data: undefined };
  }) };
}
