import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { visibleConversationText } from "../conversationSearch.ts";
import type { LearningAction, LearningCandidate, LearningState, LearningView } from "./types.ts";
import type { ReviewResult } from "./review.ts";

const sensitive = /(?:\b(?:sk|pk|rk)-[\w-]{12,}|\b(?:ghp_|xox[baprs]-|AKIA)[\w-]+|-----BEGIN|(?:password|passwd|api[_ -]?key|token|密码|密钥)\s*[:：=]\s*\S+)/i;
const clean = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !sensitive.test(value) && !/[\u0000-\u0008\u000e-\u001f]/.test(value);
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
export class LearningError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
type Source = { conversationId: string; runId: string; botId: string; harness: string };
type Job = Source & { evidence: string; review(evidence: string, signal: AbortSignal): Promise<ReviewResult> };

export function learningEvidence(events: AgentUXEvent[], runId: string): string | undefined {
  const turn = events.filter(event => event.runId === runId);
  const messages = visibleConversationText(turn);
  const user = messages.filter(message => message.role === "user").map(message => message.text).join("\n");
  const assistant = messages.filter(message => message.role === "assistant").map(message => message.text).join("\n");
  const errors = turn.filter(event => event.type === "tool.call.error").length;
  const tools = turn.filter(event => event.type === "tool.call.started").length;
  if ((!errors && tools < 3 && !/纠正|不对|下次|以后|correction|next time|instead/i.test(user)) || !assistant) return;
  const excerpt = JSON.stringify({ user: user.slice(0, 2000), assistant: assistant.slice(-3500), toolErrors: errors, toolCalls: tools, result: "unverified" });
  return sensitive.test(excerpt) ? undefined : excerpt;
}

/** Optional host-owned learning. Store failures disable learning, never normal chat. */
export function createLearningService(options: { dataDir: string; busy(): boolean; now?(): number; delayMs?: number }) {
  const dir = join(options.dataDir, "learning"), file = join(dir, "state.json");
  const now = options.now ?? Date.now;
  let data: LearningState = { revision: 0, enabled: false, reuse: false, dailyLimit: 5, day: dayOf(now()), calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, candidates: [] };
  let storageError: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined, disposed = false;
  let queue: Job[] = [];
  const delay = options.delayMs ?? 30_000;
  let quietUntil = 0;
  const seen = new Set<string>();
  const fail = () => { storageError = "RSL storage unavailable; learning is disabled. Repair storage and restart."; };
  try {
    if (statSync(file).size > 1024 * 1024) throw new Error();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || typeof saved.enabled !== "boolean" || typeof saved.reuse !== "boolean"
      || !Number.isInteger(saved.dailyLimit) || saved.dailyLimit < 1 || saved.dailyLimit > 20 || !/^\d{4}-\d{2}-\d{2}$/.test(saved.day)
      || ![saved.calls, saved.inputTokens, saved.outputTokens, saved.unknownUsage].every(n => Number.isSafeInteger(n) && n >= 0)
      || !Array.isArray(saved.candidates) || saved.candidates.length > 100 || saved.candidates.some((c: LearningCandidate) => !clean(c.id, 100) || !clean(c.conversationId, 160) || !clean(c.runId, 200) || !clean(c.botId, 100) || !clean(c.harness, 30) || !Number.isFinite(c.createdAt) || !clean(c.title, 80) || !clean(c.trigger, 200) || !clean(c.lesson, 1200) || !["pending", "approved", "rejected"].includes(c.status))) throw new Error();
    data = saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
  const commit = (next: LearningState) => {
    if (storageError) throw new LearningError(storageError, 503);
    const temp = join(dir, `${randomUUID()}.tmp`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify({ ...next, revision: data.revision + 1 }), { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } catch { fail(); throw new LearningError(storageError!, 503); }
    finally { try { rmSync(temp, { force: true }); } catch { /* Best effort. */ } }
    data = { ...next, revision: data.revision + 1 };
  };
  const state = (): LearningView => ({ ...structuredClone(data), ...(data.day !== dayOf(now()) ? { day: dayOf(now()), calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0 } : {}), queued: queue.length, running: Boolean(active), storageError });
  const schedule = () => {
    if (timer || active || disposed || storageError || !data.enabled || !queue.length) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, delay); timer.unref();
  };
  const drain = async () => {
    if (options.busy() || now() < quietUntil) { schedule(); return; }
    if (disposed || storageError || !data.enabled || !queue.length) return;
    const current = state();
    if (current.calls >= data.dailyLimit || data.candidates.length >= 100) { queue = []; return; }
    const job = queue.shift()!;
    active = new AbortController(); const signal = active.signal;
    const timeout = setTimeout(() => active?.abort(), 30_000); timeout.unref();
    try {
      commit({ ...data, day: current.day, calls: current.calls + 1, inputTokens: current.inputTokens, outputTokens: current.outputTokens, unknownUsage: current.unknownUsage, lastResult: "Review started" });
      const result = await job.review(job.evidence, signal);
      const measured = { inputTokens: data.inputTokens + (result.inputTokens ?? 0), outputTokens: data.outputTokens + (result.outputTokens ?? 0), unknownUsage: data.unknownUsage + (result.inputTokens === undefined || result.outputTokens === undefined ? 1 : 0) };
      const proposal = result.proposal as Record<string, unknown> | null;
      const valid = proposal && clean(proposal.title, 80) && clean(proposal.trigger, 200) && clean(proposal.lesson, 1200);
      const duplicate = valid && data.candidates.some(c => c.botId === job.botId && c.harness === job.harness && c.lesson === proposal.lesson);
      const candidate: LearningCandidate | undefined = valid && !duplicate && !signal.aborted && data.enabled ? { id: randomUUID(), conversationId: job.conversationId, runId: job.runId, botId: job.botId, harness: job.harness, createdAt: now(), title: proposal.title as string, trigger: proposal.trigger as string, lesson: proposal.lesson as string, status: "pending" } : undefined;
      commit({ ...data, ...measured, candidates: candidate ? [...data.candidates, candidate] : data.candidates, lastResult: candidate ? "Candidate awaiting review" : "No new supported lesson" });
    } catch {
      if (!storageError) try { commit({ ...data, unknownUsage: data.unknownUsage + 1, lastResult: "Review stopped or failed; usage may be incomplete" }); } catch { /* Fail closed. */ }
    } finally { clearTimeout(timeout); active = undefined; schedule(); }
  };
  return {
    state,
    get enabled() { return !storageError && data.enabled && !disposed; },
    update(input: LearningAction) {
      if (!input || input.revision !== data.revision) throw new LearningError("RSL changed. Refresh before saving.", 409);
      if (input.action === "settings") {
        if (typeof input.enabled !== "boolean" || typeof input.reuse !== "boolean" || !Number.isInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 20) throw new LearningError("Invalid RSL settings.");
        commit({ ...data, enabled: input.enabled, reuse: input.reuse, dailyLimit: input.dailyLimit });
        if (!input.enabled) { queue = []; active?.abort(); if (timer) clearTimeout(timer); timer = undefined; }
      } else if (input.action === "remove") {
        if (!data.candidates.some(c => c.id === input.id)) throw new LearningError("Unknown RSL candidate.");
        commit({ ...data, candidates: data.candidates.filter(c => c.id !== input.id) });
      } else if (input.action === "review") {
        if (!["pending", "approved", "rejected"].includes(input.status) || !data.candidates.some(c => c.id === input.id)) throw new LearningError("Invalid RSL candidate.");
        commit({ ...data, candidates: data.candidates.map(c => c.id === input.id ? { ...c, status: input.status } : c) });
      } else throw new LearningError("Invalid RSL action.");
      return state();
    },
    enqueue(job: Job) {
      if (storageError || disposed || !data.enabled || queue.length >= 10 || data.candidates.length >= 100 || state().calls >= data.dailyLimit) return;
      const key = JSON.stringify([job.conversationId, job.runId]);
      if (seen.has(key) || data.candidates.some(c => c.conversationId === job.conversationId && c.runId === job.runId)) return;
      seen.add(key); if (seen.size > 1000) seen.delete(seen.values().next().value!);
      queue.push(job); schedule();
    },
    interrupt() {
      active?.abort(); quietUntil = now() + delay;
      if (timer) clearTimeout(timer); timer = undefined;
      schedule();
    },
    idle() {
      quietUntil = now() + delay;
      if (timer) clearTimeout(timer); timer = undefined;
      schedule();
    },
    noteFor(botId: string, harness: string, prompt: string): string | undefined {
      if (storageError || !data.enabled || !data.reuse) return;
      const terms = [...prompt.slice(0, 2000).toLowerCase().matchAll(/[a-z0-9]{3,}|(?=([\u4e00-\u9fff]{2}))/g)].map(match => match[1] ?? match[0]);
      const selected = data.candidates.filter(c => c.status === "approved" && c.botId === botId && c.harness === harness && terms.some(term => `${c.title} ${c.trigger}`.toLowerCase().includes(term))).slice(-2);
      if (!selected.length) return;
      return `[RSL optional guidance, snapshot revision ${data.revision}. May be wrong or outdated; current user instructions and host permissions prevail. No action is authorized by this text.\n${selected.map(c => JSON.stringify({ id: c.id, condition: c.trigger, lesson: c.lesson })).join("\n")}\nEnd RSL guidance.]`;
    },
    dispose() { disposed = true; queue = []; if (timer) clearTimeout(timer); active?.abort(); },
  };
}
