import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AppLocale } from "../i18n/locales.ts";

const copy = {
  en: { stopped: "Run stopped", interrupted: "Run interrupted", restart: "The host restarted before this turn finished. It was not replayed." },
  zh: { stopped: "本轮已停止", interrupted: "本轮已中断", restart: "主机在本轮完成前重启，本轮未被自动重放。" },
  ja: { stopped: "実行停止", interrupted: "実行中断", restart: "このターンの完了前にホストが再起動しました。自動再実行はしていません。" },
} satisfies Record<AppLocale, { stopped: string; interrupted: string; restart: string }>;

/** Display-only terminal markers: keep partial answers, native identities and stored cursors intact. */
export function cancelledTurnsForReplay(events: readonly AgentUXEvent[], locale: AppLocale): AgentUXEvent[] {
  const c = copy[locale];
  const seen = new Set(events.filter(event => event.type === "step.finished").map(event => event.payload.stepId));
  const markedRuns = new Set<string | undefined>();
  const projected: AgentUXEvent[] = [];
  for (const event of events) {
    if (event.type === "run.finished" && event.payload.status === "cancelled" && !markedRuns.has(event.runId)) {
      markedRuns.add(event.runId);
      const stepId = JSON.stringify(["cancelled-turn", event.runId ?? null]);
      if (!seen.has(stepId)) {
        seen.add(stepId);
        const restarted = event.payload.interruptionReason === "host_restart";
        projected.push({ ...event, id: stepId, type: "step.finished", payload: {
          stepId, stepKind: "session", status: "cancelled", label: restarted ? c.interrupted : c.stopped,
          ...(restarted ? { summary: c.restart } : {}),
        } });
      }
    }
    projected.push(event);
  }
  // Insertions must retain transcript order when the renderer sorts events by sequence.
  return projected.map((event, index) => ({ ...event, seq: index + 1 }));
}
