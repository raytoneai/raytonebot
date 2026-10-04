import type { AgentUXEvent } from "@agent-ux/protocol";

export type UserQuestion = {
  id: string; header: string; question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean; allowOther: boolean;
};
export type UserAnswers = Record<string, string[]> | null;
export type PendingUserInput = { requestId: string; toolCallId: string; questions: UserQuestion[] };

/** Validate engine input before saving it or exposing controls. Never collect credentials here. */
export function userQuestions(value: unknown, engine: "claude" | "codex"): UserQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 4) throw new Error("Expected 1–4 user questions.");
  const questions = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || raw.isSecret === true) throw new Error("Secret or invalid user questions are not supported; use the settings page for credentials.");
    const options = raw.options ?? [];
    if (!Array.isArray(options) || options.length > 12) throw new Error("Invalid question options.");
    return {
      id: engine === "claude" ? `q${index}` : text(raw.id, 200),
      header: text(raw.header || "Question", 200), question: text(raw.question, 4000),
      options: options.map((option) => ({ label: text(option?.label, 500), description: text(option?.description ?? "", 2000, true) })),
      multiSelect: engine === "claude" && raw.multiSelect === true,
      allowOther: engine === "claude" || raw.isOther === true || options.length === 0,
    };
  });
  if (new Set(questions.map((q) => q.id)).size !== questions.length
    || new Set(questions.map((q) => q.question)).size !== questions.length
    || questions.some((q) => new Set(q.options.map((o) => o.label)).size !== q.options.length)) throw new Error("Duplicate question or option.");
  return questions;
}

export function userAnswers(value: unknown, questions: UserQuestion[]): UserAnswers {
  if (value === null) return null; // Explicitly skip, never an automatic answer.
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== questions.length) throw new Error("Answer every question or skip the request.");
  return Object.fromEntries(questions.map((q) => {
    const answers = (value as Record<string, unknown>)[q.id];
    if (!Array.isArray(answers) || !answers.length || answers.length > (q.multiSelect ? 13 : 1)) throw new Error("Invalid answer count.");
    const valid = answers.map((answer) => text(answer, 4000));
    if (new Set(valid).size !== valid.length || (!q.allowOther && valid.some((v) => !q.options.some((o) => o.label === v)))) throw new Error("Invalid answer option.");
    return [q.id, valid];
  }));
}

/** Raw persisted events are authoritative; terminal runs cannot leave a stale prompt. */
export function pendingUserInput(events: readonly AgentUXEvent[]): PendingUserInput | undefined {
  const pending = new Map<string, PendingUserInput>();
  for (const event of events) {
    if (["run.started", "run.finished", "run.error"].includes(event.type)) pending.clear();
    if (event.type === "run.awaiting_input" && Array.isArray(event.payload.questions)) pending.set(event.payload.requestId, event.payload as PendingUserInput);
    if (event.type === "tool.call.progress" && event.payload.inputRequestId) pending.delete(event.payload.inputRequestId);
  }
  return pending.values().next().value;
}

/** Existing messages present the questions/answers; suppress their raw native tool duplicate. */
export function userInputEventsForReplay(events: readonly AgentUXEvent[], skippedLabel = "Skipped questions."): AgentUXEvent[] {
  const current = pendingUserInput(events);
  const calls = new Set(events.filter((e) => e.type === "run.awaiting_input" && Array.isArray(e.payload.questions))
    .map((e) => `${e.runId}:${e.payload.toolCallId}`));
  return events.filter((e) => !(e.type.startsWith("tool.call.") && calls.has(`${e.runId}:${e.payload.toolCallId}`))
    && (e.type !== "run.awaiting_input" || !e.payload.requestId || e.payload.requestId === current?.requestId))
    .map((e) => e.type === "text.delta" && e.payload.inputSkipped === true ? { ...e, payload: { ...e.payload, delta: skippedLabel } } : e);
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new Error("Invalid user question text.");
  return value;
}
