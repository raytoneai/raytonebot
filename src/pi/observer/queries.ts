import { randomUUID } from "node:crypto";
import { evidenceHash, publicProjection, safeText, sourceKey } from "./evidence.ts";
import type { ObserverStore } from "./store.ts";
import { readVerifiedFile, verifyRepoSnapshotAsync } from "./version.ts";
import { ObserverError, type ConversationProjection, type EvidenceRef, type EvidenceView, type HostFact, type ObserverQuery, type QueryResult, type RepoSnapshot, type RunSnapshot, type SourceIdentity, type Finding, type Validity } from "./types.ts";
export type ObserverCapability = { readonly id: string };
export type ObserverRoutineStats = { id: string; botId?: string; failureCount: number; history: { at: number; status: string; durationMs?: number; conversationId?: string; runId?: string }[] };
export type ObserverLogRecord = { id?: string; segment?: string; source?: SourceIdentity; at: number; event: string; conversationId?: string; runId?: string; code?: string; status?: string; tool?: string; decision?: string; durationMs?: number };
export function createObserverQueries(options: { store: ObserverStore; repo: RepoSnapshot; conversations(): ConversationProjection[]; logs?(): ObserverLogRecord[]; config?(): Record<string, unknown>; usage?(): Record<string, unknown>; routines?(): ObserverRoutineStats[]; now?: () => number }) {
  const now = options.now ?? Date.now, caps = new Map<ObserverCapability, { snapshot: RunSnapshot; signal: AbortSignal; revoked: boolean; busy: boolean; queries: number; bytes: number; versions?: Map<string, string>; cursors: Map<string, Set<number>> }>();
  const unsub = options.store.subscribeSourceRevoked(source => { for (const item of caps.values()) if (item.snapshot.sourceScope.some(scope => sourceKey(scope) === sourceKey(source))) item.revoked = true; });
  const readableFiles = options.repo.files.filter(file => !/^(?:dist|node_modules)\//.test(file.path));
  const assertCap = async (cap: ObserverCapability) => {
    const current = caps.get(cap);
    if (!current || current.revoked || current.signal.aborted) throw new ObserverError("observer_capability_revoked", 403);
    const run = options.store.validateRun(current.snapshot.id);
    if (run.instanceId !== current.snapshot.instanceId || run.readScopeHash !== current.snapshot.readScopeHash) throw new ObserverError("observer_scope_denied", 403);
    await verifyRepoSnapshotAsync(options.repo, { signal: current.signal, check: () => { options.store.validateRun(current.snapshot.id); if (current.revoked) throw new ObserverError("observer_capability_revoked", 403); } });
    return current;
  };
  const projections = (run: RunSnapshot) => {
    const allowed = new Set(run.sourceScope.map(sourceKey));
    return options.conversations().filter(item => allowed.has(sourceKey(item.source)) && options.store.sourceValid(item.source)).map(item => {
      const projected = publicProjection(item);
      options.store.updateSourceVersion(projected.source, projected.version);
      return projected;
    });
  };
  const sanitizedValue = (type: "config" | "usage") => {
    const scrub = (value: unknown, depth = 0): unknown => {
      if (depth > 5) throw new ObserverError("observer_read_limit", 413);
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value === "string") return safeText(value, 2000);
      if (Array.isArray(value)) return value.slice(0, 100).map(item => scrub(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key, item]) => !/key|secret|password|credential|cookie|auth|token|env|reasoning|session/i.test(key) || /^(?:inputTokens|outputTokens|totalTokens|cachedInputTokens|unknownUsage)$/.test(key) && (item === null || typeof item === "number")).map(([key, item]) => [key, scrub(item, depth + 1)]));
      return null;
    };
    return scrub(type === "config" ? options.config?.() ?? {} : options.usage?.() ?? {});
  };
  const scopedLogs = (run: RunSnapshot) => {
    const sources = projections(run);
    return (options.logs?.() ?? []).flatMap(item => {
      const projected = sources.find(source => item.source ? sourceKey(source.source) === sourceKey(item.source) : item.conversationId === source.source.conversationId && item.runId && source.events.some(event => event.runId === item.runId));
      if (!projected || !options.store.sourceValid(projected.source)) return [];
      const value = { source: projected.source, at: item.at, event: String(item.event).slice(0, 100), ...(item.conversationId ? { conversationId: item.conversationId } : {}), ...(item.runId ? { runId: item.runId } : {}), ...(item.code ? { code: item.code } : {}), ...(item.status ? { status: item.status } : {}), ...(item.tool ? { tool: item.tool } : {}), ...(item.decision ? { decision: item.decision } : {}), ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}) };
      return [{ ...value, id: item.id ?? evidenceHash(value), segment: item.segment ?? "host-log" }];
    });
  };
  const scopedRoutines = (run: RunSnapshot) => {
    const sources = projections(run), ids = new Set(sources.map(item => item.source.conversationId)), bots = new Set(sources.map(item => item.botId));
    return (options.routines?.() ?? []).filter(item => item.history.some(entry => entry.conversationId && ids.has(entry.conversationId)) || item.botId && bots.has(item.botId)).map(item => ({ id: item.id, failureCount: item.failureCount, history: item.history.filter(entry => entry.conversationId && ids.has(entry.conversationId)).map(entry => ({ at: entry.at, status: entry.status, durationMs: entry.durationMs, conversationId: entry.conversationId, runId: entry.runId })), incomplete: item.history.some(entry => !entry.conversationId || !ids.has(entry.conversationId)) }));
  };
  const verifyHostRefs = (run: RunSnapshot, refs: EvidenceRef[]) => {
    for (const ref of refs) {
      if (ref.kind === "log") {
        const logs = scopedLogs(run); const selected = ref.locator.eventId ? logs.find(item => item.id === ref.locator.eventId) : undefined;
        if (ref.version !== evidenceHash(logs) || ref.locator.eventId && (!selected || evidenceHash(selected) !== ref.hash)) throw new ObserverError("observer_evidence_missing", 409);
      }
      if (ref.kind === "aggregate" && ref.locator.path === "routine-statistics" && evidenceHash(scopedRoutines(run)) !== ref.version) throw new ObserverError("observer_source_changed", 409);
      if ((ref.kind === "config" || ref.kind === "usage") && evidenceHash(sanitizedValue(ref.kind)) !== ref.version) throw new ObserverError("observer_source_changed", 409);
    }
  };
  const assertSources = (snapshot: RunSnapshot, refs: EvidenceRef[]) => {
    const values = projections(snapshot);
    for (const ref of refs) if (ref.source) {
      const source = values.find(value => sourceKey(value.source) === sourceKey(ref.source!));
      if (!source) throw new ObserverError("observer_evidence_missing", 409);
      if (source.version !== ref.version) throw new ObserverError("observer_source_changed", 409);
    }
    options.store.validateRun(snapshot.id);
  };
  return {
    createCapability(snapshot: RunSnapshot, signal = new AbortController().signal): ObserverCapability {
      const authoritative = options.store.validateRun(snapshot.id);
      if (!snapshot.sourceScope.every(source => authoritative.sourceScope.some(allowed => sourceKey(allowed) === sourceKey(source)))) throw new ObserverError("observer_scope_denied", 403);
      const cap = Object.freeze({ id: randomUUID() });
      caps.set(cap, { snapshot: { ...structuredClone(authoritative), sourceScope: structuredClone(snapshot.sourceScope) }, signal, revoked: false, busy: false, queries: 0, bytes: 0, cursors: new Map() }); return cap;
    },
    async execute(cap: ObserverCapability, query: ObserverQuery, signal?: AbortSignal): Promise<QueryResult> {
      const owner = caps.get(cap); let reservation: string | undefined;
      try {
      const current = owner; if (!current || current.revoked || current.signal.aborted) throw new ObserverError("observer_capability_revoked", 403);
      const run = current.snapshot; options.store.validateRun(run.id);
      if (signal?.aborted) throw new ObserverError("observer_cancelled", 409);
      if (current.busy) throw new ObserverError("observer_query_busy", 409);
      if (current.queries >= run.budget.maxQueries) throw new ObserverError("observer_budget_exhausted", 429);
      reservation = options.store.reserveQuery(run.id);
      current.busy = true; current.queries++;
      try {
        if (!query || typeof query !== "object" || !["repo_list", "repo_search", "repo_read", "sessions_list", "sessions_search", "session_read", "logs", "aggregate_runs", "config", "usage"].includes(query.type)) throw new ObserverError("observer_query_invalid");
        await assertCap(cap);
        const currentSources = projections(run), versions = new Map(currentSources.map(item => [sourceKey(item.source), item.version]));
        if (current.versions && (current.versions.size !== versions.size || [...versions].some(([key, version]) => current.versions!.get(key) !== version))) throw new ObserverError("observer_source_changed", 409);
        current.versions ??= versions;
        const fingerprint = evidenceHash(Object.fromEntries(Object.entries(query).filter(([key]) => key !== "cursor")));
        const queryId = randomUUID(), refs: EvidenceRef[] = [], facts: HostFact[] = [];
        const ref = (kind: EvidenceRef["kind"], version: string, hash: string, locator: EvidenceRef["locator"], source?: SourceIdentity) => {
          const value: EvidenceRef = { id: randomUUID(), runId: run.id, kind, version, hash, locator, queryId, ...(source ? { source: structuredClone(source), sourceVersion: currentSources.find(item => sourceKey(item.source) === sourceKey(source))?.version ?? version } : {}) }; refs.push(value); return value.id;
        };
        const fact = (kind: string, value: Record<string, unknown>, evidenceIds = refs.map(item => item.id)) => { facts.push({ id: randomUUID(), runId: run.id, kind, value, evidenceIds }); };
        const cursor = "cursor" in query ? query.cursor ?? 0 : 0;
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 0 && !current.cursors.get(fingerprint)?.has(cursor)) throw new ObserverError("observer_cursor_invalid");
        const limit = Math.min(run.budget.pageSize, query.type === "repo_read" ? 200 : 100);
        let content = "", nextCursor: number | undefined;
        const parameters: Record<string, string | number | string[]> = { cursor };
        const page = <T>(values: T[]) => { const selected = values.slice(cursor, cursor + limit); if (cursor + selected.length < values.length) nextCursor = cursor + selected.length; return selected; };
        const emitJSON = (values: unknown) => { content = JSON.stringify(values); };
        if (query.type === "repo_list" || query.type === "repo_search" || query.type === "repo_read") {
          const path = query.path ?? "";
          if (path && (path.startsWith("/") || path.split("/").some(part => part === ".." || !part))) throw new ObserverError("observer_path_denied", 403);
          parameters.path = path;
          if (query.type === "repo_list") {
            const files = page(readableFiles.filter(file => !path || file.path === path || file.path.startsWith(`${path}/`)));
            ref("repo", options.repo.readScopeHash, evidenceHash(files), { path });
            emitJSON(files.map(file => ({ path: file.path, bytes: file.bytes, hash: file.hash }))); fact("repo_files", { count: files.length });
          } else if (query.type === "repo_read") {
            const file = readableFiles.find(file => file.path === path); if (!file) throw new ObserverError("observer_path_denied", 403);
            const start = query.startLine ?? 1, lines = query.lines ?? 200;
            if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(lines) || lines < 1 || lines > 200) throw new ObserverError("observer_query_invalid");
            const value = safeText(readVerifiedFile(options.repo.root, path, file.hash).bytes.toString("utf8"), 16 * 1024 * 1024);
            if (start > value.split("\n").length) throw new ObserverError("observer_line_range_invalid");
            content = value.split("\n").slice(start - 1, start - 1 + lines).join("\n");
            ref("repo", options.repo.buildStamp.manifestHash, file.hash, { path, startLine: start, endLine: start + lines - 1 }); fact("repo_lines", { path, startLine: start, lines: Math.min(lines, value.split("\n").length - start + 1) });
            parameters.startLine = start; parameters.lines = lines;
          } else {
            const needle = safeText(query.text, 200); if (!needle) throw new ObserverError("observer_query_invalid"); parameters.text = needle;
            const matches: { path: string; line: number; text: string }[] = [];
            let scannedFiles = 0, skippedFiles = 0; const skippedReasons: Record<string, number> = {}; const candidates = readableFiles.filter(file => !path || file.path === path || file.path.startsWith(`${path}/`));
            for (const file of candidates) {
              scannedFiles++;
              await new Promise<void>(resolve => setImmediate(resolve));
              if (current.signal.aborted || signal?.aborted) throw new ObserverError("observer_cancelled", 409); options.store.validateRun(run.id);
              let value: string;
              try { value = safeText(readVerifiedFile(options.repo.root, file.path, file.hash, 1024 * 1024).bytes.toString("utf8"), 1024 * 1024); }
              catch (error) { if (error instanceof ObserverError && ["observer_suspected_secret", "observer_read_limit"].includes(error.code) || error instanceof Error && error.message === "observer_read_limit") { skippedFiles++; const reason = error instanceof ObserverError ? error.code : "observer_read_limit"; skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; continue; } throw error; }
              const lines = value.split("\n");
              for (let index = 0; index < lines.length; index++) if (lines[index].includes(needle)) matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 1000) });
              if (matches.length >= cursor + limit + 1) break;
            }
            const selected = page(matches); for (const match of selected) { const file = readableFiles.find(file => file.path === match.path)!; ref("repo", options.repo.buildStamp.manifestHash, file.hash, { path: match.path, startLine: match.line, endLine: match.line }); }
            emitJSON(selected); fact("repo_matches", { count: selected.length, literal: true, scannedFiles, skippedFiles, eligibleFiles: candidates.length, complete: skippedFiles === 0 && scannedFiles === candidates.length, skippedReasons });
          }
        } else if (["sessions_list", "sessions_search", "session_read", "aggregate_runs"].includes(query.type)) {
          const values = projections(run);
          if (query.type === "session_read") {
            const source = values.find(item => sourceKey(item.source) === sourceKey(query.source)); if (!source) throw new ObserverError("observer_scope_denied", 403);
            const events = page(source.events); ref("conversation", source.version, evidenceHash(events), { eventId: events[0]?.id, runId: events[0]?.runId }, source.source);
            emitJSON(events); fact("public_events", { count: events.length });
          } else if (query.type === "aggregate_runs") {
            if (!Number.isFinite(query.since) || !Number.isFinite(query.until) || query.since > query.until || query.until > now() + 1000 || query.until - query.since > run.windowDays * 86400000) throw new ObserverError("observer_window_invalid");
            const eligible = values.filter(item => item.updatedAt >= query.since && item.createdAt <= query.until);
            const selected = page(eligible);
            const runs = new Map<string, { terminal?: string }>(), unknownTimeRuns = new Set<string>();
            const counters = { samples: 0, numerator: 0, denominator: 0, executionErrors: 0, cancelled: 0, interrupted: 0, completed: 0, unterminated: 0, policyDenied: 0, policyDecisionCount: 0,
              policyDistribution: {} as Record<string, number>, unknownTimeSamples: 0, populationConversations: eligible.length, sampledConversations: selected.length,
              businessOutcome: "unknown", completeness: "public_projection_and_bounded_logs", definitionVersion: 1, since: query.since, until: query.until,
              gaps: [] as string[], routineAnomalies: [] as { id: string; consecutiveFailures: number; slowRuns: number; durationSamples: number; baselineAvailable: boolean; incomplete: boolean }[] };
            for (const source of selected) {
              ref("aggregate", source.version, evidenceHash(source.events), {}, source.source);
              for (const event of source.events) {
                if (!event.runId) continue;
                const key = `${sourceKey(source.source)}:${event.runId}`;
                if (!Number.isFinite(event.at)) { unknownTimeRuns.add(key); continue; }
                if (event.at! < query.since || event.at! > query.until) continue;
                const value = runs.get(key) ?? {}; if (event.type === "terminal") value.terminal = event.status; runs.set(key, value);
              }
            }
            for (const value of runs.values()) { if (["error", "failed"].includes(value.terminal ?? "")) counters.executionErrors++; else if (value.terminal === "cancelled") counters.cancelled++; else if (value.terminal === "interrupted") counters.interrupted++; else if (value.terminal === "success") counters.completed++; else counters.unterminated++; }
            counters.samples = counters.denominator = runs.size; counters.numerator = counters.executionErrors; counters.unknownTimeSamples = unknownTimeRuns.size;
            const logs = scopedLogs(run);
            for (const item of logs.filter(item => Number.isFinite(item.at) && item.at >= query.since && item.at <= query.until && item.event === "tool.decision" && item.decision)) {
              counters.policyDecisionCount++; const key = `${item.tool ?? "unknown"}:${item.decision}`; counters.policyDistribution[key] = (counters.policyDistribution[key] ?? 0) + 1;
              if (["denied", "refused"].includes(item.decision!)) counters.policyDenied++;
              ref("log", evidenceHash(logs), evidenceHash(item), { eventId: item.id, path: item.segment, runId: item.runId }, item.source);
            }
            const routines = scopedRoutines(run);
            ref("aggregate", evidenceHash(routines), evidenceHash(routines), { path: "routine-statistics" });
            for (const routine of routines) {
              const history = routine.history.filter(entry => Number.isFinite(entry.at) && entry.at >= query.since && entry.at <= query.until).sort((a, b) => a.at - b.at);
              const durations = history.filter(entry => Number.isFinite(entry.durationMs) && entry.durationMs! >= 0).map(entry => entry.durationMs!);
              let consecutiveFailures = 0; for (const entry of [...history].reverse()) { if (!["failed", "error"].includes(entry.status)) break; consecutiveFailures++; }
              const prior = durations.slice(0, -1).sort((a, b) => a - b), baselineAvailable = prior.length >= 3;
              const median = baselineAvailable ? prior[Math.floor(prior.length / 2)] : 0, last = durations.at(-1) ?? 0;
              counters.routineAnomalies.push({ id: routine.id, consecutiveFailures, slowRuns: baselineAvailable && last > Math.max(1000, median * 2) ? 1 : 0, durationSamples: durations.length, baselineAvailable, incomplete: routine.incomplete || durations.length !== history.length });
            }
            if (selected.length !== eligible.length) counters.gaps.push("paged_source_subset");
            if (unknownTimeRuns.size) counters.gaps.push("missing_event_timestamps");
            if (!logs.length) counters.gaps.push("no_scoped_policy_log_samples");
            if (!options.routines) counters.gaps.push("routine_history_unavailable");
            if (counters.routineAnomalies.some(item => !item.baselineAvailable)) counters.gaps.push("routine_duration_baseline_missing");
            fact("run_statistics", counters); emitJSON(counters); parameters.since = query.since; parameters.until = query.until;
          } else if (query.type === "sessions_search") {
            const needle = safeText(query.text, 200); if (!needle) throw new ObserverError("observer_query_invalid"); parameters.text = needle;
            const matches = values.flatMap(source => source.events.filter(event => ["user", "assistant"].includes(event.type) && event.text?.includes(needle)).map(event => ({ source, event })));
            const selected = page(matches); for (const match of selected) ref("conversation", match.source.version, evidenceHash(match.event), { eventId: match.event.id, runId: match.event.runId, messageId: match.event.messageId }, match.source.source);
            emitJSON(selected.map(item => ({ source: item.source.source, event: item.event }))); fact("public_message_matches", { count: selected.length, literal: true });
          } else {
            const selected = page(values); for (const source of selected) ref("conversation", source.version, evidenceHash(source.events), {}, source.source);
            emitJSON(selected.map(source => ({ source: source.source, botId: source.botId, harness: source.harness, createdAt: source.createdAt, updatedAt: source.updatedAt, eventCount: source.events.length }))); fact("public_sessions", { count: selected.length });
          }
        } else if (query.type === "logs") {
          const logs = scopedLogs(run), selected = page(logs);
          if (!selected.length) ref("log", evidenceHash(logs), evidenceHash(selected), {});
          for (const item of selected) ref("log", evidenceHash(logs), evidenceHash(item), { eventId: item.id, path: item.segment, runId: item.runId }, item.source);
          emitJSON(selected); fact("log_records", { count: selected.length, completeness: "bounded_scoped_host_log", unknownUnscopedOmitted: true });
        } else {
          const kind = query.type === "config" ? "config" : "usage", value = sanitizedValue(kind);
          ref(kind, evidenceHash(value), evidenceHash(value), {}); emitJSON(value); fact(kind === "config" ? "sanitized_config" : "reported_usage", { available: true });
        }
        safeText(content, run.budget.pageBytes);
        const bytes = Buffer.byteLength(content);
        if (current.bytes + bytes > run.budget.maxBytes) throw new ObserverError("observer_budget_exhausted", 429);
        if (signal?.aborted) throw new ObserverError("observer_cancelled", 409);
        await assertCap(cap); assertSources(run, refs.filter(ref => ref.kind !== "log")); verifyHostRefs(run, refs);
        const result: QueryResult = { content, bytes, facts, evidenceRefs: refs, queryRecord: { id: queryId, type: query.type, at: now(), implementationVersion: 1, evidenceIds: refs.map(item => item.id), bytes, parameters, reproducible: true }, ...(nextCursor !== undefined ? { nextCursor } : {}) };
        if (nextCursor !== undefined) { const cursors = current.cursors.get(fingerprint) ?? new Set<number>(); cursors.add(nextCursor); current.cursors.set(fingerprint, cursors); }
        result.bytes = Buffer.byteLength(JSON.stringify(result)); result.queryRecord.bytes = result.bytes;
        result.bytes = Buffer.byteLength(JSON.stringify(result)); result.queryRecord.bytes = result.bytes;
        if (result.bytes > run.budget.pageBytes || current.bytes + result.bytes > run.budget.maxBytes) throw new ObserverError("observer_budget_exhausted", 429);
        options.store.recordQuery(run.id, result, reservation); current.bytes += result.bytes; return result;
      } finally { current.busy = false; }
      } catch (error) {
        const code = error instanceof ObserverError ? error.code : error instanceof Error && /^observer_[a-z_]{1,60}$/.test(error.message) ? error.message : "observer_query_failed";
        try { options.store.recordQueryRejection(owner?.snapshot.id, code, reservation); } catch { /* Storage failure is already fail closed. */ }
        throw new ObserverError(code, error instanceof ObserverError ? error.status : 400);
      }
    },
    async beforePublication(snapshot: RunSnapshot, ids: { factIds: string[]; evidenceIds: string[] }) {
      await verifyRepoSnapshotAsync(options.repo); const run = options.store.validateRun(snapshot.id);
      if (ids.factIds.some(id => !run.facts.some(fact => fact.id === id)) || ids.evidenceIds.some(id => !run.evidenceRefs.some(ref => ref.id === id))) throw new ObserverError("observer_fact_invalid", 403);
      assertSources(snapshot, run.evidenceRefs.filter(ref => ref.kind !== "log")); verifyHostRefs(run, run.evidenceRefs);
    },
    async openEvidence(findingId: string, revision: number, refId: string): Promise<EvidenceView> {
      const finding = options.store.get(findingId); if (!finding || finding.revision !== revision) throw new ObserverError("observer_revision_conflict", 409);
      const ref = finding.evidenceRefs.find(item => item.id === refId); if (!ref) throw new ObserverError("observer_evidence_missing", 404);
      if (finding.validity !== "current") throw new ObserverError("observer_evidence_stale", 409);
      await verifyRepoSnapshotAsync(options.repo);
      const run = options.store.getRun(finding.observerRunId)!; verifyHostRefs(run, [ref]);
      let text: string, sourceLabel: string;
      if (ref.kind === "repo" && ref.locator.path) {
        const file = readableFiles.find(file => file.path === ref.locator.path); if (!file || file.hash !== ref.hash) throw new ObserverError("observer_source_changed", 409);
        text = safeText(readVerifiedFile(options.repo.root, file.path, ref.hash).bytes.toString("utf8"), 16 * 1024 * 1024).split("\n").slice((ref.locator.startLine ?? 1) - 1, ref.locator.endLine ?? 200).join("\n"); sourceLabel = file.path;
      } else if (ref.kind === "log") {
        const logs = scopedLogs(run); text = JSON.stringify(ref.locator.eventId ? logs.filter(item => item.id === ref.locator.eventId) : []); sourceLabel = ref.locator.path ?? "Scoped host log";
      } else if (ref.kind === "aggregate" && ref.locator.path === "routine-statistics") {
        text = JSON.stringify(scopedRoutines(run)); sourceLabel = "Scoped routine statistics";
      } else if (ref.kind === "config" || ref.kind === "usage") {
        text = JSON.stringify(sanitizedValue(ref.kind)); sourceLabel = ref.kind;
      } else if (ref.source) {
        const source = projections({ ...options.store.getRun(finding.observerRunId)!, sourceScope: finding.scope }).find(item => sourceKey(item.source) === sourceKey(ref.source!));
        if (!source || source.version !== ref.version) throw new ObserverError("observer_source_changed", 409);
        text = JSON.stringify(source.events.filter(event => !ref.locator.eventId || event.id === ref.locator.eventId).slice(0, 100)); sourceLabel = source.source.conversationId;
      } else throw new ObserverError("observer_evidence_unavailable", 409);
      return { title: finding.title, language: ref.kind === "repo" ? "text" : "json", text: safeText(text), sourceLabel, validity: "current", readOnly: true };
    },
    async refreshFindingValidity(finding: Finding, refresh: { repoVerified?: boolean } = {}): Promise<Validity> {
      if (!finding.scope.every(source => options.store.sourceValid(source))) return "evidence_missing";
      try {
        if (!refresh.repoVerified) await verifyRepoSnapshotAsync(options.repo);
        const run = options.store.getRun(finding.observerRunId); if (!run) return "evidence_missing";
        const values = projections(run);
        for (const ref of finding.evidenceRefs) if (ref.source) { const value = values.find(item => sourceKey(item.source) === sourceKey(ref.source!)); if (!value) return "evidence_missing"; if (value.version !== (ref.sourceVersion ?? ref.version)) return "stale"; }
        verifyHostRefs(run, finding.evidenceRefs);
        return options.store.get(finding.id)?.validity ?? "evidence_missing";
      } catch (error) { return error instanceof ObserverError && ["observer_evidence_missing", "observer_source_deleted"].includes(error.code) ? "evidence_missing" : "stale"; }
    },
    revokeRun(runId: string) { for (const current of caps.values()) if (current.snapshot.id === runId) current.revoked = true; },
    dispose() { unsub(); caps.clear(); },
  };
}
export type ObserverQueries = ReturnType<typeof createObserverQueries>;
