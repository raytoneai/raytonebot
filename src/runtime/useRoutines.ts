import { useCallback, useEffect, useRef, useState } from "react";

import { deleteRoutine, listRoutines, runRoutineNow, setRoutineEnabled, updateRoutine } from "../pi/piClient";
import type { RoutineDefinitionPatch, RoutineView } from "../pi/routineTypes";

export type RoutinesState = {
  routines?: RoutineView[];
  error?: string;
  busy?: string;
  actionError?: { id: string; message: string };
  setEnabled(id: string, enabled: boolean): Promise<void>;
  runNow(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  update(id: string, patch: RoutineDefinitionPatch): Promise<boolean>;
};

/**
 * Routines (ADR-033) run on the host. Refresh while their settings section is open;
 * Raer creates routines from chat.
 */
export function useRoutines(active: boolean): RoutinesState {
  const [routines, setRoutines] = useState<RoutineView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<RoutinesState["actionError"]>();
  const loadSequence = useRef(0);
  const acting = useRef(false);

  const load = useCallback(() => {
    const sequence = ++loadSequence.current;
    return listRoutines().then((value) => {
      if (sequence !== loadSequence.current) return;
      setRoutines(value);
      setError(undefined);
    }, (failure: unknown) => { if (sequence === loadSequence.current) setError(failure instanceof Error ? failure.message : String(failure)); });
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 3_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); loadSequence.current++; };
  }, [active, load]);

  const act = useCallback(async (id: string, action: () => Promise<unknown>) => {
    if (acting.current) return false;
    acting.current = true;
    loadSequence.current++;
    setBusy(id);
    setActionError(undefined);
    try {
      await action();
      await load();
      return true;
    } catch (failure) {
      setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
      await load(); // A conflict refreshes authoritative data, without replacing the editor's draft.
      return false;
    } finally {
      acting.current = false;
      setBusy(undefined);
    }
  }, [load]);

  return {
    routines, error, busy, actionError,
    setEnabled: async (id, enabled) => { await act(id, () => setRoutineEnabled(id, enabled)); },
    runNow: async (id) => { await act(id, () => runRoutineNow(id)); },
    remove: async (id) => { await act(id, () => deleteRoutine(id)); },
    update: (id, patch) => act(id, () => updateRoutine(id, patch)),
  };
}
