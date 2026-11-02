import type { ControlAuthorization } from "../controlPlaneAuth.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
type Job = Source & { origin?: LearningCandidate["origin"]; sourceEpoch?: number; sourceEpochs?: Record<string, number>; evidence: string; review(evidence: string, signal: AbortSignal): Promise<ReviewResult> };

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
export function createLearningService(options: { dataDir: string; busy(): boolean; now?(): number; delayMs?: number; validateCandidate?(candidate: LearningCandidate): boolean }) {
  const dir = join(options.dataDir, "learning"), file = join(dir, "state.json");
  const now = options.now ?? Date.now;
  let data: LearningState = { revision: 0, enabled: false, reuse: false, dailyLimit: 5, day: dayOf(now()), calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, candidates: [] };
  let storageError: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined, disposed = false;
  let queue: Job[] = [];
  const deletedSources = new Set<string>();
  const sourceEpochs = new Map<string, number>();
  const sourceGenerations = new Map<string, string>();
  let activeSource: string | undefined;
  let activeJob: Job | undefined;
  const originSources = (item: { origin?: LearningCandidate["origin"] }) => [...(item.origin?.sources ?? []), ...(item.origin?.source ? [item.origin.source] : [])];
  const dependencies = (item: { conversationId: string; origin?: LearningCandidate["origin"] }) => [...new Set([item.conversationId, ...originSources(item).map(source => source.conversationId)])];
  const matchesSource = (item: { conversationId: string; origin?: LearningCandidate["origin"] }, conversationId: string, generation?: string) => originSources(item).some(source => source.conversationId === conversationId && (!generation || source.generation === generation)) || item.conversationId === conversationId && !originSources(item).some(source => source.conversationId === conversationId);
  const sourceAvailable = (candidate: LearningCandidate) => {
    try { return dependencies(candidate).every(id => !deletedSources.has(id)) && candidate.validity !== "stale" && candidate.validity !== "evidence_missing" && (options.validateCandidate ? options.validateCandidate(candidate) : dependencies(candidate).every(id => existsSync(join(options.dataDir, "conversations", `${encodeURIComponent(id)}.json`)))); }
    catch { return false; }
  };
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
    if (saved.reuseRecords !== undefined && (!Array.isArray(saved.reuseRecords) || saved.reuseRecords.length > 500 || saved.reuseRecords.some((item: Record<string, unknown>) => !clean(item.candidateId, 100) || !clean(item.conversationId, 160) || !clean(item.runId, 200) || !Number.isSafeInteger(item.candidateRevision) || !Number.isFinite(item.at)))) throw new Error();
    if (saved.candidates.some((candidate: LearningCandidate) => candidate.revision !== undefined && (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) || candidate.validity !== undefined && !["current", "stale", "evidence_missing"].includes(candidate.validity))) throw new Error();
    data = saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
  const commit = (next: LearningState) => {
    if (storageError) throw new LearningError(storageError, 503);
    const temp = join(dir, `${randomUUID()}.tmp`);
    if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024 - 256) throw new LearningError("RSL storage limit reached. Remove old candidates before saving.", 507);
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
    active = new AbortController(); activeSource = job.conversationId; activeJob = job; const signal = active.signal;
    const timeout = setTimeout(() => active?.abort(), 30_000); timeout.unref();
    try {
      commit({ ...data, day: current.day, calls: current.calls + 1, inputTokens: current.inputTokens, outputTokens: current.outputTokens, unknownUsage: current.unknownUsage, lastResult: "Review started" });
      const result = await job.review(job.evidence, signal);
      const measured = { inputTokens: data.inputTokens + (result.inputTokens ?? 0), outputTokens: data.outputTokens + (result.outputTokens ?? 0), unknownUsage: data.unknownUsage + (result.inputTokens === undefined || result.outputTokens === undefined ? 1 : 0) };
      const proposal = result.proposal as Record<string, unknown> | null;
      const valid = proposal && clean(proposal.title, 80) && clean(proposal.trigger, 200) && clean(proposal.lesson, 1200);
      const duplicate = valid && data.candidates.some(c => c.botId === job.botId && c.harness === job.harness && c.lesson === proposal.lesson);
      const candidate: LearningCandidate | undefined = valid && !duplicate && !signal.aborted && data.enabled && !deletedSources.has(job.conversationId) && job.sourceEpoch === (sourceEpochs.get(job.conversationId) ?? 0) && Object.entries(job.sourceEpochs ?? {}).every(([id, epoch]) => epoch === (sourceEpochs.get(id) ?? 0)) ? { id: randomUUID(), conversationId: job.conversationId, runId: job.runId, botId: job.botId, harness: job.harness, createdAt: now(), title: proposal.title as string, trigger: proposal.trigger as string, lesson: proposal.lesson as string, status: "pending", revision: 1, validity: "current", origin: job.origin ? structuredClone(job.origin) : { kind: "rsl" } } : undefined;
      commit({ ...data, ...measured, candidates: candidate ? [...data.candidates, candidate] : data.candidates, lastResult: candidate ? "Candidate awaiting review" : "No new supported lesson" });
    } catch {
      if (!storageError) try { commit({ ...data, unknownUsage: data.unknownUsage + 1, lastResult: "Review stopped or failed; usage may be incomplete" }); } catch { /* Fail closed. */ }
    } finally { clearTimeout(timeout); active = undefined; activeSource = undefined; activeJob = undefined; schedule(); }
  };
  return {
    state,
    get enabled() { return !storageError && data.enabled && !disposed; },
    update(input: LearningAction, authorization?: ControlAuthorization) {
      if (!input || input.revision !== data.revision) throw new LearningError("RSL changed. Refresh before saving.", 409);
      const authorized = authorization ? { lastAuthorization: structuredClone(authorization) } : {};
      if (input.action === "settings") {
        if (typeof input.enabled !== "boolean" || typeof input.reuse !== "boolean" || !Number.isInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 20) throw new LearningError("Invalid RSL settings.");
        commit({ ...data, ...authorized, enabled: input.enabled, reuse: input.reuse, dailyLimit: input.dailyLimit });
        if (!input.enabled) { queue = []; active?.abort(); if (timer) clearTimeout(timer); timer = undefined; }
      } else if (input.action === "remove") {
        if (!data.candidates.some(c => c.id === input.id)) throw new LearningError("Unknown RSL candidate.");
        commit({ ...data, ...authorized, candidates: data.candidates.filter(c => c.id !== input.id) });
      } else if (input.action === "review") {
        if (!["pending", "approved", "rejected"].includes(input.status) || !data.candidates.some(c => c.id === input.id)) throw new LearningError("Invalid RSL candidate.");
        commit({ ...data, ...authorized, candidates: data.candidates.map(c => c.id === input.id ? { ...c, status: input.status, revision: (c.revision ?? 0) + 1 } : c) });
      } else throw new LearningError("Invalid RSL action.");
      return state();
    },
    enqueue(job: Job) {
      if (dependencies(job).some(id => deletedSources.has(id)) || storageError || disposed || !data.enabled || queue.length >= 10 || data.candidates.length >= 100 || state().calls >= data.dailyLimit) return;
      const key = JSON.stringify([job.conversationId, job.runId]);
      if (seen.has(key) || data.candidates.some(c => c.conversationId === job.conversationId && c.runId === job.runId)) return;
      seen.add(key); if (seen.size > 1000) seen.delete(seen.values().next().value!);
      queue.push({ ...job, sourceEpoch: sourceEpochs.get(job.conversationId) ?? 0, sourceEpochs: Object.fromEntries(dependencies(job).map(id => [id, sourceEpochs.get(id) ?? 0])) }); schedule();
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
    registerSourceGeneration(conversationId: string, generation: string) {
      if (sourceGenerations.get(conversationId) !== generation) { sourceGenerations.set(conversationId, generation); sourceEpochs.set(conversationId, (sourceEpochs.get(conversationId) ?? 0) + 1); deletedSources.delete(conversationId); }
    },
    deleteSource(conversationId: string, generation?: string) {
      sourceEpochs.set(conversationId, (sourceEpochs.get(conversationId) ?? 0) + 1);
      deletedSources.add(conversationId); queue = queue.filter(job => !matchesSource(job, conversationId, generation));
      if (activeSource === conversationId || activeJob && matchesSource(activeJob, conversationId, generation)) active?.abort();
      const removed = data.candidates.filter(candidate => matchesSource(candidate, conversationId, generation));
      if (removed.length) commit({ ...data, candidates: data.candidates.filter(candidate => !removed.includes(candidate)), reuseRecords: (data.reuseRecords ?? []).filter(item => !removed.some(candidate => candidate.id === item.candidateId)) });
    },
    addObserverCandidate(input: Pick<LearningCandidate, "conversationId" | "runId" | "botId" | "harness" | "title" | "trigger" | "lesson" | "origin" | "evidenceRefs">) {
      if (storageError) throw new LearningError(storageError, 503);
      if (dependencies(input).some(id => deletedSources.has(id)) || !clean(input.conversationId, 160) || !clean(input.runId, 200) || !clean(input.botId, 100) || !clean(input.harness, 30) || !clean(input.title, 80) || !clean(input.trigger, 200) || !clean(input.lesson, 1200)
        || input.origin?.kind !== "observer" || !clean(input.origin.findingId, 100) || !Number.isSafeInteger(input.origin.findingRevision) || data.candidates.length >= 100) throw new LearningError("Invalid Observer candidate.");
      const candidate: LearningCandidate = { ...structuredClone(input), id: randomUUID(), createdAt: now(), status: "pending", revision: 1, validity: "current" };
      commit({ ...data, candidates: [...data.candidates, candidate] }); return structuredClone(candidate);
    },
    noteFor(botId: string, harness: string, prompt: string, target?: { conversationId: string; runId: string }): string | undefined {
      if (storageError || !data.enabled || !data.reuse) return;
      const terms = [...prompt.slice(0, 2000).toLowerCase().matchAll(/[a-z0-9]{3,}|(?=([\u4e00-\u9fff]{2}))/g)].map(match => match[1] ?? match[0]);
      const selected = data.candidates.filter(c => c.status === "approved" && sourceAvailable(c) && c.botId === botId && c.harness === harness && terms.some(term => `${c.title} ${c.trigger}`.toLowerCase().includes(term))).slice(-2);
      if (!selected.length) return;
      if (target) {
        if (!clean(target.conversationId, 160) || !clean(target.runId, 200)) return;
        try { commit({ ...data, reuseRecords: [...(data.reuseRecords ?? []), ...selected.map(candidate => ({ candidateId: candidate.id, candidateRevision: candidate.revision ?? 0, conversationId: target.conversationId, runId: target.runId, at: now() }))].slice(-500) }); } catch { return; }
      }
      if (!selected.every(sourceAvailable)) return;
      return `[RSL optional guidance, snapshot revision ${data.revision}. May be wrong or outdated; current user instructions and host permissions prevail. No action is authorized by this text.\n${selected.map(c => JSON.stringify({ id: c.id, condition: c.trigger, lesson: c.lesson })).join("\n")}\nEnd RSL guidance.]`;
    },
    dispose() { disposed = true; queue = []; if (timer) clearTimeout(timer); active?.abort(); },
  };
}
