import { useCallback, useEffect, useRef, useState } from "react";
import { getLearning, updateLearning } from "../pi/piClient";
import type { LearningAction, LearningView } from "../pi/learning/types";
export function useLearning(active: boolean) {
  const [state, setState] = useState<LearningView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false), mounted = useRef(true), generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const accept = useCallback((next: LearningView) => { if (mounted.current) { setState(previous => previous && previous.revision > next.revision ? previous : next); setError(undefined); } }, []);
  const refresh = useCallback(async () => {
    const visit = generation.current;
    try { const next = await getLearning(); if (visit === generation.current) accept(next); }
    catch (failure) { if (mounted.current && visit === generation.current) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [accept]);
  useEffect(() => {
    if (!active) return;
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [active, refresh]);
  const update = async (action: LearningAction) => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { accept(await updateLearning(action)); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return { state, error, busy, refresh, update };
}
export type LearningSettings = ReturnType<typeof useLearning>;
