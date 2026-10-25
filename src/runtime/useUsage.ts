import { useCallback, useEffect, useRef, useState } from "react";
import { getUsage } from "../pi/piClient";
import type { UsageState } from "../pi/usageTypes";

export type UsageViewState = { state?: UsageState; error?: string; refresh(): void };

/** Poll only while its settings surface is visible; stale reads cannot replace a newer visit. */
export function useUsage(active: boolean): UsageViewState {
  const [state, setState] = useState<UsageState>();
  const [error, setError] = useState<string>();
  const visible = useRef(false), pending = useRef(false), generation = useRef(0);
  const refresh = useCallback(() => {
    if (!visible.current || pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    void getUsage().then(value => {
      if (!visible.current || request !== generation.current) return;
      setState(value); setError(undefined);
    }, (failure: unknown) => {
      if (visible.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (request === generation.current) pending.current = false; });
  }, []);
  useEffect(() => {
    visible.current = active;
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { window.clearInterval(timer); visible.current = false; pending.current = false; generation.current++; };
  }, [active, refresh]);
  return { state, error, refresh };
}
