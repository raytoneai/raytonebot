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
  const reading = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; loadSequence.current++; reading.current = undefined; };
  }, []);

  const load = useCallback(async (afterAction = false) => {
    if (!mounted.current || (!afterAction && (acting.current || reading.current !== undefined))) return;
    const sequence = ++loadSequence.current;
    reading.current = sequence;
    try {
      const value = await listRoutines();
      if (!mounted.current || sequence !== loadSequence.current) return;
      setRoutines(value);
      setError(undefined);
    } catch (failure) {
      if (mounted.current && sequence === loadSequence.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (reading.current === sequence) reading.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 3_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); loadSequence.current++; reading.current = undefined; };
  }, [active, load]);

  const act = useCallback(async (id: string, action: () => Promise<unknown>) => {
    if (acting.current || !mounted.current) return false;
    acting.current = true;
    loadSequence.current++;
    reading.current = undefined;
    setBusy(id);
    setActionError(undefined);
    try {
      await action();
      if (!mounted.current) return false;
      await load(true);
      return true;
    } catch (failure) {
      if (mounted.current) setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
      await load(true); // A conflict refreshes authoritative data, without replacing the editor's draft.
      return false;
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(undefined);
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
