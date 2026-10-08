import { useCallback, useEffect, useState } from "react";

import { deleteRoutine, listRoutines, runRoutineNow, setRoutineEnabled } from "../pi/piClient";
import type { RoutineView } from "../pi/routineTypes";

export type RoutinesState = {
  routines?: RoutineView[];
  error?: string;
  busy?: string;
  actionError?: { id: string; message: string };
  setEnabled(id: string, enabled: boolean): Promise<void>;
  runNow(id: string): Promise<void>;
  remove(id: string): Promise<void>;
};

/**
 * Routines (ADR-033), read from the host while the settings page is open. Polled there, since
 * runs start and finish on the server; Raer creates them from chat.
 */
export function useRoutines(active: boolean): RoutinesState {
  const [routines, setRoutines] = useState<RoutineView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<RoutinesState["actionError"]>();

  const load = useCallback(() => listRoutines().then((value) => {
    setRoutines(value);
    setError(undefined);
  }, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))), []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const act = useCallback(async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setActionError(undefined);
    try {
      await action();
      await load();
    } catch (failure) {
      setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setBusy(undefined);
    }
  }, [load]);

  return {
    routines, error, busy, actionError,
    setEnabled: (id, enabled) => act(id, () => setRoutineEnabled(id, enabled)),
    runNow: (id) => act(id, () => runRoutineNow(id)),
    remove: (id) => act(id, () => deleteRoutine(id)),
  };
}
