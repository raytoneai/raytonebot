import { useCallback, useEffect, useRef, useState } from "react";
import { getLearning, updateLearning } from "../pi/piClient";
import type { LearningAction, LearningView } from "../pi/learning/types";
export function useLearning(active: boolean) {
  const [state, setState] = useState<LearningView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const locked = useRef(false), mounted = useRef(true), generation = useRef(0), reading = useRef<number | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; reading.current = undefined; }; }, []);
  const accept = useCallback((next: LearningView) => { if (mounted.current) { setState(previous => previous && previous.revision > next.revision ? previous : next); setError(undefined); } }, []);
  const refresh = useCallback(async () => {
    if (!mounted.current || locked.current || reading.current !== undefined) return;
    const visit = ++generation.current;
    reading.current = visit;
    try { const next = await getLearning(); if (visit === generation.current) accept(next); }
    catch (failure) { if (mounted.current && visit === generation.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (reading.current === visit) reading.current = undefined; }
  }, [accept]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => { stopped = true; generation.current++; reading.current = undefined; window.clearTimeout(timer); };
  }, [active, refresh]);
  const update = async (action: LearningAction) => {
    if (locked.current || !mounted.current) return;
    locked.current = true; reading.current = undefined; setBusy(true);
    const visit = ++generation.current;
    try {
      const next = await updateLearning(action);
      if (mounted.current && visit === generation.current) accept(next);
    } catch (failure) {
      if (mounted.current && visit === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return { state, error, busy, refresh, update };
}
export type LearningSettings = ReturnType<typeof useLearning>;
