export type SourceIdentity = { instanceId: string; conversationId: string; generation: string };
export type Validity = "current" | "stale" | "evidence_missing";
export type ObserverBudget = { dailyRequests: number; maxRequests: number; maxDurationMs: number; maxQueries: number; maxBytes: number; pageBytes: number; pageSize: number };
export type ObserverSettings = { enabled: boolean; background: boolean; windowDays: number; revision: number; model?: { provider: string; model: string; configRevision: string }; budget: ObserverBudget; authorizedVia?: string; authorizedAt?: number };
export type BuildStamp = { schemaVersion: 1; gitRevision: string | null; dirty: boolean | null; manifestHash: string; buildId: string; files: { path: string; hash: string; bytes: number }[] };
export type BuildSummary = Omit<BuildStamp, "files">;
export type RepoSnapshot = { root: string; manifestPath?: string; manifestFileHash?: string; buildStamp: BuildStamp; readScopeHash: string; files: { path: string; hash: string; bytes: number }[] };
export type HostFact = { id: string; runId: string; kind: string; value: Record<string, unknown>; evidenceIds: string[] };
export type EvidenceRef = { id: string; runId: string; kind: "repo" | "conversation" | "log" | "aggregate" | "config" | "usage"; source?: SourceIdentity; sourceVersion?: string; version: string; hash: string; locator: { path?: string; startLine?: number; endLine?: number; runId?: string; eventId?: string; messageId?: string }; queryId: string };
export type QueryRecord = { id: string; type: ObserverQuery["type"]; at: number; implementationVersion: 1; evidenceIds: string[]; bytes: number; parameters: Record<string, string | number | string[]>; reproducible: boolean };
export type ProposedAction = { kind: "inspect" | "change_code" | "add_test" | "change_config" | "update_docs" | "propose_lesson"; target: { kind: "code" | "configuration" | "experience" | "project"; id: string }; description: string; verificationRefs: string[] };
export type FindingProposal = { kind: "project_suggestion" | "experience_candidate"; inference: string; proposedAction: ProposedAction; factIds: string[]; title: string };
export type Finding = FindingProposal & { schemaVersion: 1; id: string; revision: number; observerRunId: string; analysisLevel: "L1" | "L2"; requestedBy: "user_session" | "background"; authorizedVia: string; instanceId: string; createdAt: number; model: { provider: string; model: string; configRevision: string }; instructionVersion: string; buildStamp: BuildSummary; readScopeHash: string; querySet: QueryRecord[]; facts: HostFact[]; evidenceRefs: EvidenceRef[]; scope: SourceIdentity[]; reviewStatus: "pending" | "accepted" | "rejected" | "disabled"; validity: Validity; budgetSpent: BudgetSpent; dedupKey: string; supersedes?: string; implementationRefs?: string[]; effectRefs?: string[]; reviewAuthorization?: string; reviewedAt?: number; approvedRevision?: number; approvedAction?: ProposedAction };
export type BudgetSpent = { requests: number; queries: number; bytes: number; inputTokens: number; outputTokens: number; unknownUsage: number; durationMs: number };
export type RunSnapshot = { id: string; instanceId: string; level: "L1" | "L2"; requestedBy: "user_session" | "background"; authorizedVia: string; startedAt: number; expiresAt: number; windowDays: number; evidenceValidUntil: number; sourceScope: SourceIdentity[]; settingsRevision: number; executionConfigHash: string; model: { provider: string; model: string; configRevision: string }; buildStamp: BuildSummary; readScopeHash: string; budget: ObserverBudget; status: "running" | "success" | "no_findings" | "cancelled" | "interrupted" | "failed" | "budget_exhausted"; spent: BudgetSpent; facts: HostFact[]; evidenceRefs: EvidenceRef[]; queryRecords: QueryRecord[]; pendingQueries?: string[]; queryRejections?: { id: string; code: string; at: number }[]; instructionVersion: string; report?: string; question?: string; conversationId?: string; clientRequestId?: string; title?: string; endedAt?: number; errorCode?: string };
export type PublicEvent = { id: string; runId?: string; messageId?: string; type: "user" | "assistant" | "tool" | "approval" | "terminal"; text?: string; tool?: string; status?: string; at?: number };
export type ConversationProjection = { source: SourceIdentity; version: string; botId: string; harness: string; createdAt: number; updatedAt: number; events: PublicEvent[] };
export type ObserverQuery =
  | { type: "repo_list"; path?: string; cursor?: number }
  | { type: "repo_search"; text: string; path?: string; cursor?: number }
  | { type: "repo_read"; path: string; startLine?: number; lines?: number }
  | { type: "sessions_list"; cursor?: number }
  | { type: "sessions_search"; text: string; cursor?: number }
  | { type: "session_read"; source: SourceIdentity; cursor?: number }
  | { type: "logs"; cursor?: number }
  | { type: "aggregate_runs"; since: number; until: number; cursor?: number }
  | { type: "config" }
  | { type: "usage" };
export type QueryResult = { facts: HostFact[]; evidenceRefs: EvidenceRef[]; content: string; queryRecord: QueryRecord; bytes: number; nextCursor?: number };
export type EvidenceView = { title: string; language: string; text: string; sourceLabel: string; validity: Validity; readOnly: true };
export class ObserverError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
