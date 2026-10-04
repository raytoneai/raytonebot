import { useRef, useState, type RefObject } from "react";
import { abortPiRun } from "../pi/piClient.ts";

export type RunStopStatus = "pending" | "failed" | "idle";
type StopState = { controller: AbortController; runId?: string; status: RunStopStatus };

/** Confirmation belongs to this subscription; an old response cannot stop its replacement. */
export async function requestRunStop(
  id: string, controllers: Map<string, AbortController>, preparing: ReadonlySet<string>,
  pending: Map<string, string>, report: (id: string, state: StopState) => void,
  runIds: WeakMap<AbortController, string>,
  send: (id: string, runId: string) => Promise<void> = (id, runId) => abortPiRun(id, undefined, runId),
) {
  const controller = controllers.get(id);
  if (!controller || controller.signal.aborted) return;
  if (preparing.has(id)) { controller.abort(); return; }
  const runId = runIds.get(controller);
  if (!runId) { report(id, { controller, status: "failed" }); return; }
  if (pending.get(id) === runId) return;
  pending.set(id, runId);
  report(id, { controller, runId, status: "pending" });
  let failed = false;
  try { await send(id, runId); } catch { failed = true; }
  finally {
    if (pending.get(id) === runId) pending.delete(id);
    if (controllers.get(id) === controller && runIds.get(controller) === runId && !controller.signal.aborted) {
      report(id, { controller, runId, status: failed ? "failed" : "idle" });
      if (!failed) controller.abort();
    }
  }
}

/** Keep stop feedback outside persisted events and their reconnection cursor. */
export function useRunStop(controllers: RefObject<Map<string, AbortController>>, preparing: RefObject<Set<string>>) {
  const pending = useRef(new Map<string, string>());
  const runIds = useRef(new WeakMap<AbortController, string>());
  const [states, setStates] = useState<Record<string, StopState>>({});
  return {
    bind(controller: AbortController, runId?: string) { if (runId) runIds.current.set(controller, runId); },
    statusFor(id: string) {
      const state = states[id];
      return state && state.controller === controllers.current.get(id) && state.runId === runIds.current.get(state.controller) ? state.status : undefined;
    },
    stop: (id: string) => requestRunStop(id, controllers.current, preparing.current, pending.current,
      (key, state) => setStates(current => ({ ...current, [key]: state })), runIds.current),
  };
}
