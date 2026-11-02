import { controlPlaneFetch } from "./controlPlaneSession.ts";
import type { BotProfile } from "./botProfiles.ts";
import type { EvidenceView, Finding, ObserverBudget, ImplementationInput, EffectInput, FollowUp, FollowUpSource } from "../pi/observer/types.ts";
export const OBSERVER_BOT_ID = "system:observer";
export type ObserverView = {
  l2Available: boolean; l2UnavailableReason?: string;
  revision: number; enabled: boolean; backgroundEnabled: boolean; windowDays: number;
  model: { provider: string; model: string; configRevision: string; available: boolean } | null;
  models: { provider: string; model: string; label: string; available: boolean; configRevision: string }[];
  budgets: ObserverBudget;
  usage: { day: string; calls: number; inputTokens: number; outputTokens: number; unknownUsage: number };
  runState: { running: boolean; runId?: string; level?: string; status?: string; errorCode?: string };
  systemBot?: BotProfile;
  findings: Finding[];
  finishedWithoutFindings: number;
};
export type ObserverAction =
  | { action: "settings"; revision: number; enabled: boolean; backgroundEnabled: boolean; windowDays: number; model: { provider: string; model: string } | null; budgets: ObserverBudget }
  | { action: "analyze" }
  | { action: "clear_finished_runs" }
  | { action: "stop"; runId: string }
  | { action: "record_implementation"; id: string; revision: number; followUpRevision: number; implementation: ImplementationInput }
  | { action: "record_effect"; id: string; revision: number; followUpRevision: number; effect: EffectInput }
  | { action: "review"; id: string; revision: number; status: "accepted" | "rejected" | "disabled" }
  | { action: "remove"; id: string; revision: number }
  | { action: "lesson"; id: string; revision: number; botId: string; harness: string }
  | { action: "handoff"; id: string; revision: number; botId: string; scope: string };
export type ObserverHandoff = { token: string; id: string; revision: number; botId: string; scope: string; expiresAt: number };
const prefix = "/__agentcanvas/pi/observer";
async function observerRequest<T>(url: string, action?: ObserverAction, signal?: AbortSignal): Promise<T> {
  const response = await controlPlaneFetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), cache: "no-store",
    ...(action ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.code ?? "observer_request_failed");
  return body;
}
export const getObserver = (signal?: AbortSignal) => observerRequest<ObserverView>(prefix, undefined, signal);
export const updateObserver = (action: ObserverAction) => observerRequest<{ handoff?: ObserverHandoff; draft?: string; cleared?: number; followUp?: FollowUp }>(prefix, action);
export const getObserverFollowUpSources = (options: { cursor?: number; limit?: number; query?: string } = {}, signal?: AbortSignal) => observerRequest<{ sources: FollowUpSource[]; nextCursor?: number }>(`${prefix}/follow-up-sources?${new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`, undefined, signal);
export const getObserverFinding = (id: string, revision: number, signal?: AbortSignal) => observerRequest<Finding>(`${prefix}/findings/${encodeURIComponent(id)}?revision=${revision}`, undefined, signal);
export const getObserverEvidence = (findingId: string, revision: number, evidenceId: string, signal?: AbortSignal) => observerRequest<EvidenceView>(`${prefix}/evidence?${new URLSearchParams({ findingId, revision: String(revision), evidenceId })}`, undefined, signal);
export function isObserverConversation(value: { systemRole?: string; botId?: string; id: string }): boolean {
  return value.systemRole === "observer" || value.botId === OBSERVER_BOT_ID && value.id.startsWith("observer:");
}

/** Saved projections replace transient tool events before calculating a live cursor. */
export function observerHistoryBaseline(
  current: import("../pi/piConversationState.ts").EphemeralPiConversation,
  saved: import("../pi/piClient.ts").StoredConversationSummary & { events: import("@agent-ux/protocol").AgentUXEvent[] },
): import("../pi/piConversationState.ts").EphemeralPiConversation {
  if (!isObserverConversation(saved) || saved.id !== current.id) throw new Error("observer_conversation_invalid");
  return { ...current, title: saved.title, events: saved.events, activeRunId: saved.activeRunId, stored: false,
    botId: OBSERVER_BOT_ID, systemRole: "observer", agentPreset: "assistant", acceptedRequestIds: saved.acceptedRequestIds };
}
