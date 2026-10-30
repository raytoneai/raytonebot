export type LearningCandidate = {
  id: string; conversationId: string; runId: string; botId: string; harness: string;
  createdAt: number; title: string; trigger: string; lesson: string;
  status: "pending" | "approved" | "rejected";
};
export type LearningState = {
  revision: number; enabled: boolean; reuse: boolean; dailyLimit: number;
  day: string; calls: number; inputTokens: number; outputTokens: number; unknownUsage: number;
  candidates: LearningCandidate[]; lastResult?: string;
};
export type LearningView = LearningState & { queued: number; running: boolean; storageError?: string };
export type LearningAction = { revision: number } & (
  { action: "settings"; enabled: boolean; reuse: boolean; dailyLimit: number }
  | { action: "remove"; id: string }
  | { action: "review"; id: string; status: LearningCandidate["status"] }
);
