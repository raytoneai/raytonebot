import type { SourceIdentity, Validity } from "../observer/types.ts";
import type { ControlAuthorization } from "../controlPlaneAuth.ts";
export type LearningCandidate = {
  id: string; conversationId: string; runId: string; botId: string; harness: string;
  createdAt: number; title: string; trigger: string; lesson: string;
  status: "pending" | "approved" | "rejected";
  revision?: number;
  validity?: Validity;
  origin?: { kind: "rsl" | "observer"; findingId?: string; findingRevision?: number; source?: SourceIdentity; sources?: SourceIdentity[]; buildHash?: string; readScopeHash?: string };
  evidenceRefs?: string[];
};
export type LearningState = {
  revision: number; enabled: boolean; reuse: boolean; dailyLimit: number;
  day: string; calls: number; inputTokens: number; outputTokens: number; unknownUsage: number;
  candidates: LearningCandidate[]; lastResult?: string;
  reuseRecords?: { candidateId: string; candidateRevision: number; conversationId: string; runId: string; at: number }[];
  /** Saved atomically with the accepted action; no credentials or request body. */
  lastAuthorization?: ControlAuthorization;
};
export type LearningView = LearningState & { queued: number; running: boolean; storageError?: string };
export type LearningAction = { revision: number } & (
  { action: "settings"; enabled: boolean; reuse: boolean; dailyLimit: number }
  | { action: "remove"; id: string }
  | { action: "review"; id: string; status: LearningCandidate["status"] }
);
