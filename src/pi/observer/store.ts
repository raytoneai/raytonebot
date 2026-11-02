import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "../../../scripts/observer-manifest.mjs";
import { evidenceHash, safeText, sourceKey } from "./evidence.ts";
import { ObserverError, type BudgetSpent, type Finding, type FindingProposal, type ObserverBudget, type ObserverSettings, type QueryResult, type RepoSnapshot, type RunSnapshot, type SourceIdentity, type Validity } from "./types.ts";
const DEFAULT_BUDGET: ObserverBudget = { dailyRequests: 10, maxRequests: 6, maxDurationMs: 120000, maxQueries: 20, maxBytes: 262144, pageBytes: 32768, pageSize: 100 };
const MAX_FINDINGS = 500, MAX_CONTENT = 10 * 1024 * 1024, MAX_SOURCES = 10000, MAX_RUNS = 500;
type SourceRecord = { source: SourceIdentity; birthKey: string; version?: string; deleted: boolean };
type State = { schemaVersion: 1; instanceId: string; revision: number; settings: ObserverSettings; day: string; requests: number; runs: RunSnapshot[]; findings: Finding[]; sources: SourceRecord[]; tombstones: { source: SourceIdentity; at: number; cleanupPending: boolean }[]; handled: { key: string; value: string }[]; buildHash?: string; readScopeHash?: string; manifestHashes?: string[]; manifestCleanup?: string[]; currentModelRevision?: string | null; queryRejections?: { id: string; runId?: string; code: string; at: number }[] };
const clone = <T>(value: T): T => structuredClone(value);
const dayOf = (value: number) => new Date(value).toISOString().slice(0, 10);
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function budgetValid(value: ObserverBudget): boolean { return record(value) && Object.entries(DEFAULT_BUDGET).every(([key]) => Number.isSafeInteger(value[key as keyof ObserverBudget]) && value[key as keyof ObserverBudget] > 0)
  && value.dailyRequests <= 1000 && value.maxRequests <= 100 && value.maxDurationMs <= 3600000 && value.maxQueries <= 200 && value.maxBytes <= 4 * 1024 * 1024 && value.pageBytes <= 65536 && value.pageSize <= 200; }
const freshSpent = (): BudgetSpent => ({ requests: 0, queries: 0, bytes: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, durationMs: 0 });
export function createObserverStore(options: { dataDir: string; instanceId?: string; now?: () => number }) {
  const now = options.now ?? Date.now, root = join(options.dataDir, "observer"), file = join(root, "state.json");
  let data: State = { schemaVersion: 1, instanceId: options.instanceId ?? randomUUID(), revision: 0, settings: { enabled: false, background: false, windowDays: 7, revision: 0, budget: DEFAULT_BUDGET }, day: dayOf(now()), requests: 0, runs: [], findings: [], sources: [], tombstones: [], handled: [] };
  let storageError: string | undefined;
  const listeners = new Set<(source: SourceIdentity) => void>();
  const fail = () => { storageError = "observer_storage_unavailable"; };
  const usable = () => { if (storageError) throw new ObserverError(storageError, 503); };
  const commit = (next: State, essential = false) => {
    usable();
    const serialized = JSON.stringify({ ...next, revision: data.revision + 1 });
    if (Buffer.byteLength(serialized) > (essential ? 24 : 18) * 1024 * 1024) throw new ObserverError("observer_metadata_full", 507);
    const temporary = join(root, `${randomUUID()}.tmp`);
    try {
      if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error();
      const updated = { ...next, revision: data.revision + 1 };
      chmodSync(root, 0o700);
      writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
      const tempFd = openSync(temporary, constants.O_RDONLY); try { fsyncSync(tempFd); } finally { closeSync(tempFd); }
      renameSync(temporary, file);
      const dirFd = openSync(root, constants.O_RDONLY); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      data = updated;
    } catch { fail(); throw new ObserverError(storageError!, 503); }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Preserve the storage failure. */ } }
  };
  try {
    if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error();
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let saved: State;
    try { if (fstatSync(fd).size > 24 * 1024 * 1024) throw new Error(); saved = JSON.parse(readFileSync(fd, "utf8")); }
    finally { closeSync(fd); }
    if (!record(saved) || saved.schemaVersion !== 1 || typeof saved.instanceId !== "string" || !Number.isSafeInteger(saved.revision)
      || !record(saved.settings) || !budgetValid(saved.settings.budget) || typeof saved.settings.enabled !== "boolean" || typeof saved.settings.background !== "boolean"
      || !Number.isSafeInteger(saved.settings.revision) || !/^\d{4}-\d{2}-\d{2}$/.test(saved.day) || !Number.isSafeInteger(saved.requests)
      || !Array.isArray(saved.sources) || saved.sources.length > MAX_SOURCES || saved.sources.some(item => !record(item.source) || sourceKey(item.source).length > 1000 || typeof item.birthKey !== "string" || typeof item.deleted !== "boolean")
      || !Array.isArray(saved.tombstones) || saved.tombstones.length > MAX_SOURCES || saved.tombstones.some(item => !record(item.source) || typeof item.cleanupPending !== "boolean")
      || !Array.isArray(saved.findings) || saved.findings.length > MAX_FINDINGS || saved.findings.some(item => !record(item) || item.schemaVersion !== 1 || !Array.isArray(item.scope) || !Array.isArray(item.evidenceRefs) || typeof item.inference !== "string")
      || !Array.isArray(saved.runs) || saved.runs.length > MAX_RUNS || saved.runs.some(item => !record(item) || !Array.isArray(item.sourceScope) || !Array.isArray(item.facts) || !Array.isArray(item.evidenceRefs) || !Array.isArray(item.queryRecords) || !record(item.spent))
      || !Array.isArray(saved.handled) || saved.handled.length > 1000) throw new Error();
    if (options.instanceId && saved.instanceId !== options.instanceId) throw new Error();
    data = saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
  const knownSource = (source: SourceIdentity) => data.sources.find(item => sourceKey(item.source) === sourceKey(source));
  const sourceValid = (source: SourceIdentity) => !storageError && source.instanceId === data.instanceId && Boolean(knownSource(source) && !knownSource(source)!.deleted)
    && [...data.sources].reverse().find(item => item.source.conversationId === source.conversationId)?.source.generation === source.generation
    && !data.tombstones.some(item => sourceKey(item.source) === sourceKey(source));
  const visibleRun = (run: RunSnapshot) => run.sourceScope.every(sourceValid);
  const validity = (finding: Finding): Validity => {
    if (!finding.scope.every(sourceValid)) return "evidence_missing";
    if (finding.buildStamp.manifestHash !== data.buildHash || finding.readScopeHash !== data.readScopeHash || finding.model.configRevision !== data.settings.model?.configRevision || data.currentModelRevision !== undefined && finding.model.configRevision !== data.currentModelRevision
      || finding.evidenceRefs.some(ref => ref.source && knownSource(ref.source)?.version !== (ref.sourceVersion ?? ref.version))) return "stale";
    const run = data.runs.find(run => run.id === finding.observerRunId);
    if (!run || run.evidenceValidUntil <= now()) return "stale";
    return finding.validity;
  };
  const requireRun = (id: string) => { usable(); const run = data.runs.find(run => run.id === id); if (!run) throw new ObserverError("observer_run_missing", 404); return run; };
  const validateRun = (id: string) => {
    const run = requireRun(id);
    if (!data.settings.enabled || run.status !== "running") throw new ObserverError("observer_run_revoked", 403);
    if (!visibleRun(run)) throw new ObserverError("observer_source_deleted", 409);
    if (run.expiresAt <= now()) throw new ObserverError("observer_budget_exhausted", 429);
    if (run.requestedBy === "background" && !data.settings.background || run.executionConfigHash !== evidenceHash([data.settings.model, data.settings.budget, data.settings.windowDays]) || run.model.configRevision !== data.settings.model?.configRevision || data.currentModelRevision !== undefined && run.model.configRevision !== data.currentModelRevision || run.buildStamp.manifestHash !== data.buildHash || run.readScopeHash !== data.readScopeHash) throw new ObserverError("observer_snapshot_stale", 409);
    if (run.evidenceRefs.some(ref => ref.source && knownSource(ref.source)?.version !== (ref.sourceVersion ?? ref.version))) throw new ObserverError("observer_source_changed", 409);
    return run;
  };
  const cleanupDeleted = () => {
    const affected = (sources: SourceIdentity[]) => sources.some(source => !sourceValid(source));
    const runs = data.runs.map(run => affected(run.sourceScope) ? { ...run, sourceScope: [], facts: [], evidenceRefs: [], queryRecords: [], report: undefined, question: undefined, title: undefined, pendingQueries: [], status: "cancelled" as const, errorCode: "observer_source_deleted", endedAt: now() } : run);
    commit({ ...data, findings: data.findings.filter(finding => !affected(finding.scope)), runs, tombstones: data.tombstones.map(item => ({ ...item, cleanupPending: false })) }, true);
  };
  const cleanupManifests = () => {
    const pending = data.manifestCleanup ?? [];
    if (!pending.length) return;
    try { for (const hash of pending) { if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(); rmSync(join(root, "manifests", `${hash}.json`), { force: true }); } }
    catch { fail(); throw new ObserverError("observer_storage_unavailable", 503); }
    commit({ ...data, manifestCleanup: [] }, true);
  };
  if (!storageError && data.manifestCleanup?.length) try { cleanupManifests(); } catch { fail(); }
  if (!storageError && (data.runs.some(run => run.status === "running") || data.settings.background || data.tombstones.some(item => item.cleanupPending))) {
    try {
      commit({ ...data, settings: { ...data.settings, background: false, revision: data.settings.revision + (data.settings.background ? 1 : 0) }, runs: data.runs.map(run => run.status === "running" ? { ...run, status: "interrupted", endedAt: now(), errorCode: "observer_host_restarted" } : run) }, true);
      if (data.tombstones.some(item => item.cleanupPending)) cleanupDeleted();
    } catch { fail(); }
  }
  const api = {
    root,
    get storageError() { return storageError; },
    state() { usable(); return { ...clone(data), findings: api.list(), runs: api.runs() }; },
    settings() { usable(); return clone(data.settings); },
    updateSettings(expectedRevision: number, input: Partial<Omit<ObserverSettings, "revision">>, authorizedVia: string) {
      usable(); if (data.settings.revision !== expectedRevision) throw new ObserverError("observer_revision_conflict", 409);
      safeText(authorizedVia, 200);
      if (Object.keys(input).some(key => !["enabled", "background", "budget", "model", "windowDays"].includes(key))) throw new ObserverError("observer_settings_invalid");
      const settings = { ...data.settings, ...clone(input), revision: expectedRevision + 1, authorizedVia, authorizedAt: now() };
      if (typeof settings.enabled !== "boolean" || typeof settings.background !== "boolean" || !Number.isSafeInteger(settings.windowDays) || settings.windowDays < 1 || settings.windowDays > 366 || !budgetValid(settings.budget) || settings.model && (![settings.model.provider, settings.model.model, settings.model.configRevision].every(value => typeof value === "string" && value.length > 0 && value.length <= 200))) throw new ObserverError("observer_settings_invalid");
      if (settings.background && !settings.enabled) throw new ObserverError("observer_settings_invalid");
      commit({ ...data, settings }, !settings.enabled); return clone(settings);
    },
    registerSource(conversationId: string, birthKey: string): SourceIdentity {
      usable(); if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(conversationId) || !birthKey || birthKey.length > 200) throw new ObserverError("observer_source_invalid");
      const current = [...data.sources].reverse().find(item => item.source.conversationId === conversationId);
      if (current && current.birthKey === birthKey) return clone(current.source);
      if (current && !current.deleted) api.beginSourceDeletion(current.source);
      if (data.sources.length >= MAX_SOURCES) throw new ObserverError("observer_metadata_full", 507);
      const source = { instanceId: data.instanceId, conversationId, generation: randomUUID() };
      commit({ ...data, sources: [...data.sources, { source, birthKey, deleted: false }] }); return clone(source);
    },
    sourceValid,
    updateSourceVersion(source: SourceIdentity, version: string) { usable(); if (!sourceValid(source)) throw new ObserverError("observer_source_deleted", 409); if (knownSource(source)!.version !== version) commit({ ...data, sources: data.sources.map(item => sourceKey(item.source) === sourceKey(source) ? { ...item, version } : item) }); },
    sources(conversationId?: string) { usable(); return clone(data.sources.filter(item => !conversationId || item.source.conversationId === conversationId)); },
    beginSourceDeletion(source: SourceIdentity) {
      usable(); if (!knownSource(source)) throw new ObserverError("observer_source_missing", 404);
      if (!data.tombstones.some(item => sourceKey(item.source) === sourceKey(source))) commit({ ...data, sources: data.sources.map(item => sourceKey(item.source) === sourceKey(source) ? { ...item, deleted: true } : item), tombstones: [...data.tombstones, { source: clone(source), at: now(), cleanupPending: true }] }, true);
      for (const listener of listeners) try { listener(clone(source)); } catch { /* Durable tombstone remains authoritative. */ }
      cleanupDeleted();
    },
    subscribeSourceRevoked(listener: (source: SourceIdentity) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    setCurrentModelRevision(revision: string | undefined) { usable(); const value = revision ?? null; if (data.currentModelRevision !== value) commit({ ...data, currentModelRevision: value }); },
    setRepoSnapshot(repo: RepoSnapshot) {
      usable(); const hash = repo.buildStamp.manifestHash, previousHashes = data.manifestHashes ?? [], hashes = previousHashes.filter(value => value === hash || data.runs.some(run => run.buildStamp.manifestHash === value));
      if (!hashes.includes(hash)) {
        if (hashes.length >= 20 || Buffer.byteLength(JSON.stringify(repo.buildStamp)) > 4 * 1024 * 1024) throw new ObserverError("observer_metadata_full", 507);
        const manifests = join(root, "manifests"), path = join(manifests, `${hash}.json`);
        try {
          if (lstatSync(manifests, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error();
          mkdirSync(manifests, { recursive: true, mode: 0o700 }); chmodSync(manifests, 0o700);
          const existing = lstatSync(path, { throwIfNoEntry: false });
          if (existing) {
            if (!existing.isFile() || existing.isSymbolicLink()) throw new Error();
            const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try { if (fstatSync(fd).size > 4 * 1024 * 1024) throw new Error(); const saved = validateManifest(JSON.parse(readFileSync(fd, "utf8"))); if (saved.manifestHash !== hash || evidenceHash(saved.files) !== evidenceHash(repo.buildStamp.files)) throw new Error(); }
            finally { closeSync(fd); }
            chmodSync(path, 0o600);
          } else {
            const temporary = join(manifests, `${randomUUID()}.tmp`); writeFileSync(temporary, JSON.stringify(repo.buildStamp), { mode: 0o600, flag: "wx" });
            const fd = openSync(temporary, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
            renameSync(temporary, path);
          }
        } catch { fail(); throw new ObserverError("observer_storage_unavailable", 503); }
      }
      if (hashes.length !== previousHashes.length || !hashes.includes(hash) || data.buildHash !== hash || data.readScopeHash !== repo.readScopeHash) {
        const retained = hashes.includes(hash) ? hashes : [...hashes, hash];
        commit({ ...data, manifestHashes: retained, manifestCleanup: [...(data.manifestCleanup ?? []), ...previousHashes.filter(value => !retained.includes(value))], buildHash: hash, readScopeHash: repo.readScopeHash });
        cleanupManifests();
      }
    },
    reserveRun(input: { level: "L1" | "L2"; requestedBy: "user_session" | "background"; authorizedVia: string; sourceScope: SourceIdentity[]; repo: RepoSnapshot; instructionVersion: string; question?: string; conversationId?: string; clientRequestId?: string }): RunSnapshot {
      usable(); if (!data.settings.enabled || !data.settings.model || input.requestedBy === "background" && !data.settings.background) throw new ObserverError("observer_disabled", 403);
      if (input.clientRequestId) {
        if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(input.clientRequestId)) throw new ObserverError("observer_request_invalid");
        const previous = data.runs.find(run => run.conversationId === input.conversationId && run.clientRequestId === input.clientRequestId);
        if (previous) throw new ObserverError(previous.question === input.question ? "observer_duplicate_request" : "observer_request_conflict", 409);
      }
      if (data.runs.some(run => run.status === "running")) throw new ObserverError("observer_busy", 409);
      if (data.runs.length >= MAX_RUNS) throw new ObserverError("observer_metadata_full", 507);
      if (!input.sourceScope.every(sourceValid)) throw new ObserverError("observer_source_deleted", 409);
      if (input.conversationId && !/^observer:[a-zA-Z0-9._:-]{1,150}$/.test(input.conversationId)) throw new ObserverError("observer_conversation_invalid");
      api.setRepoSnapshot(input.repo);
      const budget = { ...data.settings.budget, ...(input.level === "L1" ? { maxRequests: 1, maxDurationMs: Math.min(30000, data.settings.budget.maxDurationMs) } : {}) };
      const run: RunSnapshot = { id: randomUUID(), instanceId: data.instanceId, level: input.level, requestedBy: input.requestedBy, authorizedVia: safeText(input.authorizedVia, 200), startedAt: now(), expiresAt: now() + budget.maxDurationMs, windowDays: data.settings.windowDays, evidenceValidUntil: now() + data.settings.windowDays * 86400000, sourceScope: clone(input.sourceScope), settingsRevision: data.settings.revision, executionConfigHash: evidenceHash([data.settings.model, data.settings.budget, data.settings.windowDays]), model: clone(data.settings.model), buildStamp: (({ files: _files, ...summary }) => clone(summary))(input.repo.buildStamp), readScopeHash: input.repo.readScopeHash, budget, status: "running", spent: freshSpent(), facts: [], evidenceRefs: [], queryRecords: [], instructionVersion: input.instructionVersion,
        ...(input.question ? { question: safeText(input.question, 4000) } : {}), ...(input.conversationId ? { conversationId: input.conversationId } : {}), ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) };
      commit({ ...data, runs: [...data.runs, run] }); return clone(run);
    },
    validateRun(id: string) { return clone(validateRun(id)); },
    chargeModelRequest(id: string) { const run = validateRun(id), day = dayOf(now()), count = day === data.day ? data.requests : 0;
      if (count >= data.settings.budget.dailyRequests || run.spent.requests >= run.budget.maxRequests) throw new ObserverError("observer_budget_exhausted", 429);
      commit({ ...data, day, requests: count + 1, runs: data.runs.map(item => item.id === id ? { ...item, spent: { ...item.spent, requests: item.spent.requests + 1 } } : item) });
      return clone(requireRun(id).spent);
    },
    recordUsage(id: string, usage: { inputTokens?: number; outputTokens?: number; unknownUsage?: number }) {
      const run = requireRun(id);
      if (Object.values(usage).some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new ObserverError("observer_usage_invalid");
      commit({ ...data, runs: data.runs.map(item => item.id === id ? { ...item, spent: { ...run.spent, inputTokens: run.spent.inputTokens + (usage.inputTokens ?? 0), outputTokens: run.spent.outputTokens + (usage.outputTokens ?? 0), unknownUsage: run.spent.unknownUsage + (usage.unknownUsage ?? (usage.inputTokens === undefined || usage.outputTokens === undefined ? 1 : 0)) } } : item) }, true);
    },
    reserveQuery(id: string): string { const run = validateRun(id); if (run.spent.queries >= run.budget.maxQueries || run.spent.bytes >= run.budget.maxBytes) throw new ObserverError("observer_budget_exhausted", 429); const reservation = randomUUID(); commit({ ...data, runs: data.runs.map(item => item.id === id ? { ...item, pendingQueries: [...(item.pendingQueries ?? []), reservation], spent: { ...item.spent, queries: item.spent.queries + 1 } } : item) }); return reservation; },
    recordQueryRejection(id: string | undefined, code: string, reservation?: string) { usable(); const row = { id: randomUUID(), ...(id && data.runs.some(run => run.id === id) ? { runId: id } : {}), code: /^observer_[a-z_]{1,60}$/.test(code) ? code : "observer_query_failed", at: now() }; commit({ ...data, queryRejections: [...(data.queryRejections ?? []), row].slice(-100), runs: data.runs.map(run => run.id === id ? { ...run, pendingQueries: (run.pendingQueries ?? []).filter(value => value !== reservation), queryRejections: [...(run.queryRejections ?? []), { id: row.id, code: row.code, at: row.at }].slice(-20) } : run) }, true); },
    recordQuery(id: string, result: QueryResult, reservation?: string) { const run = validateRun(id);
      if (reservation && !run.pendingQueries?.includes(reservation)) throw new ObserverError("observer_query_reservation_invalid", 403);
      if (!reservation && run.spent.queries >= run.budget.maxQueries || run.spent.bytes + result.bytes > run.budget.maxBytes || result.bytes > run.budget.pageBytes || result.facts.some(fact => fact.runId !== id) || result.evidenceRefs.some(ref => ref.runId !== id)) throw new ObserverError("observer_budget_exhausted", 429);
      commit({ ...data, runs: data.runs.map(item => item.id === id ? { ...item, facts: [...item.facts, ...clone(result.facts)], evidenceRefs: [...item.evidenceRefs, ...clone(result.evidenceRefs)], queryRecords: [...item.queryRecords, clone(result.queryRecord)], pendingQueries: (item.pendingQueries ?? []).filter(value => value !== reservation), spent: { ...item.spent, queries: item.spent.queries + (reservation ? 0 : 1), bytes: item.spent.bytes + result.bytes } } : item) });
    },
    commitReport(id: string, input: { report: string; proposals: FindingProposal[]; usage?: { inputTokens?: number; outputTokens?: number } }): Finding[] {
      const run = validateRun(id); safeText(input.report, 65536);
      if (!Array.isArray(input.proposals) || input.proposals.length > 10) throw new ObserverError("observer_proposal_invalid");
      const findings = input.proposals.map(proposal => {
        if (!record(proposal) || Object.keys(proposal).some(key => !["kind", "inference", "proposedAction", "factIds", "title"].includes(key)) || !["project_suggestion", "experience_candidate"].includes(proposal.kind)
          || !Array.isArray(proposal.factIds) || !proposal.factIds.length || proposal.factIds.some(factId => !run.facts.some(fact => fact.id === factId))) throw new ObserverError("observer_fact_invalid");
        safeText(proposal.title, 240); safeText(proposal.inference, 8000);
        const action = proposal.proposedAction;
        if (!record(action) || Object.keys(action).some(key => !["kind", "target", "description", "verificationRefs"].includes(key)) || !["inspect", "change_code", "add_test", "change_config", "update_docs", "propose_lesson"].includes(action.kind) || !record(action.target) || !["code", "configuration", "experience", "project"].includes(action.target.kind)
          || Object.keys(action.target).some(key => !["kind", "id"].includes(key)) || typeof action.target.id !== "string" || action.target.id.length > 1000 || !Array.isArray(action.verificationRefs) || action.verificationRefs.some(ref => !run.evidenceRefs.some(item => item.id === ref))) throw new ObserverError("observer_action_invalid");
        safeText(action.target.id, 1000); safeText(action.description, 2000);
        const kinds: Record<string, string[]> = { inspect: ["project", "code", "configuration", "experience"], change_code: ["code"], add_test: ["code"], change_config: ["configuration"], update_docs: ["code"], propose_lesson: ["experience"] };
        if (!kinds[action.kind].includes(action.target.kind) || action.target.kind === "configuration" && !["observer.enabled", "observer.background", "observer.budget", "observer.model", "rsl.enabled", "rsl.reuse", "routine.schedule"].includes(action.target.id)
          || action.target.kind === "project" && action.target.id !== "current_project" || action.target.kind === "experience" && !run.sourceScope.some(source => source.conversationId === action.target.id)) throw new ObserverError("observer_action_invalid");
        if (action.target.kind === "code" && !run.evidenceRefs.some(ref => ref.kind === "repo" && ref.locator.path === action.target.id)) throw new ObserverError("observer_action_invalid");
        const facts = run.facts.filter(fact => proposal.factIds.includes(fact.id));
        const evidenceRefs = run.evidenceRefs.filter(ref => facts.some(fact => fact.evidenceIds.includes(ref.id)));
        if (action.verificationRefs.some(id => !evidenceRefs.some(ref => ref.id === id))) throw new ObserverError("observer_action_invalid");
        const finding: Finding = { ...clone(proposal), schemaVersion: 1, id: randomUUID(), revision: 1, observerRunId: id, analysisLevel: run.level, requestedBy: run.requestedBy, authorizedVia: run.authorizedVia, instanceId: data.instanceId, createdAt: now(), model: clone(run.model), instructionVersion: run.instructionVersion, buildStamp: clone(run.buildStamp), readScopeHash: run.readScopeHash, querySet: clone(run.queryRecords), facts: clone(facts), evidenceRefs: clone(evidenceRefs), scope: clone(run.sourceScope), reviewStatus: "pending", validity: "current", budgetSpent: clone(run.spent), dedupKey: evidenceHash([proposal.kind, proposal.proposedAction.target, run.sourceScope, evidenceRefs.map(ref => ref.hash)]) };
        const previous = [...data.findings].reverse().find(item => item.dedupKey === finding.dedupKey);
        if (previous) finding.supersedes = previous.id;
        return finding;
      });
      const measured = { ...run.spent, durationMs: Math.max(0, now() - run.startedAt), inputTokens: run.spent.inputTokens + (input.usage?.inputTokens ?? 0), outputTokens: run.spent.outputTokens + (input.usage?.outputTokens ?? 0), unknownUsage: run.spent.unknownUsage + (input.usage && (input.usage.inputTokens === undefined || input.usage.outputTokens === undefined) ? 1 : 0) };
      const next = { ...data, findings: [...data.findings.map(item => findings.some(next => next.supersedes === item.id) ? { ...item, validity: "stale" as const } : item), ...findings], runs: data.runs.map(item => item.id === id ? { ...item, status: findings.length ? "success" as const : "no_findings" as const, report: input.report, endedAt: now(), spent: measured } : item) };
      if (next.findings.length > MAX_FINDINGS || Buffer.byteLength(JSON.stringify({ findings: next.findings, reports: next.runs.map(item => item.report) })) > MAX_CONTENT) throw new ObserverError("observer_report_full", 507);
      validateRun(id); commit(next); return clone(findings);
    },
    finishRun(id: string, status: RunSnapshot["status"], errorCode?: string) { const run = requireRun(id); if (status === "running") throw new ObserverError("observer_status_invalid"); if (run.status !== "running") return;
      commit({ ...data, runs: data.runs.map(item => item.id === id ? { ...item, status, pendingQueries: [], endedAt: now(), spent: { ...item.spent, durationMs: Math.max(0, now() - item.startedAt) }, ...(errorCode ? { errorCode: safeText(errorCode, 100) } : {}) } : item) }, true); },
    setFindingValidity(id: string, validity: Validity) { usable(); const rank = { current: 0, stale: 1, evidence_missing: 2 }; if (!["current", "stale", "evidence_missing"].includes(validity)) throw new ObserverError("observer_finding_invalid"); if (data.findings.some(finding => finding.id === id && rank[validity] > rank[finding.validity])) commit({ ...data, findings: data.findings.map(finding => finding.id === id && rank[validity] > rank[finding.validity] ? { ...finding, validity } : finding) }, true); },
    list() { usable(); return clone(data.findings.filter(finding => finding.scope.every(sourceValid)).map(finding => ({ ...finding, validity: validity(finding) }))); },
    get(id: string) { return api.list().find(finding => finding.id === id); },
    runs() { usable(); return clone(data.runs.filter(visibleRun)); },
    getRun(id: string) { return api.runs().find(run => run.id === id); },
    review(input: { id: string; revision: number; status: Finding["reviewStatus"] }, authorizedVia: string) { usable(); safeText(authorizedVia, 200); const finding = api.get(input.id); if (!finding) throw new ObserverError("observer_finding_missing", 404);
      if (finding.revision !== input.revision) throw new ObserverError("observer_revision_conflict", 409);
      if (!["pending", "accepted", "rejected", "disabled"].includes(input.status) || input.status === "accepted" && finding.validity !== "current") throw new ObserverError("observer_finding_invalid", 409);
      commit({ ...data, findings: data.findings.map(item => item.id === input.id ? { ...item, revision: item.revision + 1, reviewStatus: input.status, reviewAuthorization: authorizedVia, reviewedAt: now(), ...(input.status === "accepted" ? { approvedRevision: item.revision, approvedAction: clone(item.proposedAction) } : { approvedRevision: undefined, approvedAction: undefined }) } : item) }); return api.get(input.id)!;
    },
    deleteFinding(id: string, revision: number) { usable(); const finding = api.get(id); if (!finding || finding.revision !== revision) throw new ObserverError("observer_revision_conflict", 409); const findings = data.findings.filter(item => item.id !== id);
      const runs = data.runs.filter(run => run.id !== finding.observerRunId || findings.some(item => item.observerRunId === run.id));
      commit({ ...data, findings, runs }, true); },
    deleteRun(id: string) { usable(); const run = requireRun(id); if (run.status === "running") throw new ObserverError("observer_busy", 409); commit({ ...data, runs: data.runs.filter(item => item.id !== id), findings: data.findings.filter(item => item.observerRunId !== id) }, true); },
    deleteConversation(id: string) { usable(); const related = data.runs.filter(run => run.conversationId === id); if (related.some(run => run.status === "running")) throw new ObserverError("observer_busy", 409); const ids = new Set(related.map(run => run.id)); commit({ ...data, runs: data.runs.filter(run => !ids.has(run.id)), findings: data.findings.filter(finding => !ids.has(finding.observerRunId)) }, true); },
    renameConversation(id: string, title: string) { usable(); safeText(title, 240); if (!title.trim() || !data.runs.some(run => run.conversationId === id)) throw new ObserverError("observer_conversation_missing", 404); commit({ ...data, runs: data.runs.map(run => run.conversationId === id ? { ...run, title: title.trim() } : run) }); },
    markHandled(key: string, value: string) { usable(); safeText(key, 300); safeText(value, 300); const handled = data.handled.filter(item => item.key !== key); if (handled.length >= 1000) throw new ObserverError("observer_metadata_full", 507); commit({ ...data, handled: [...handled, { key, value }] }); },
    handled(key: string) { usable(); return data.handled.find(item => item.key === key)?.value; },
    dispose() { listeners.clear(); },
  };
  return api;
}
export type ObserverStore = ReturnType<typeof createObserverStore>;
