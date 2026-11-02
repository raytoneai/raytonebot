import { useCallback, useEffect, useRef, useState } from "react";
import { getObserver, updateObserver, type ObserverAction, type ObserverView } from "./observerClient.ts";
import { controlPlaneSession } from "./controlPlaneSession.ts";
export function useObserver(active: boolean) {
  const [state, setState] = useState<ObserverView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0), mounted = useRef(true), reading = useRef<number | undefined>(undefined), locked = useRef(false), previousEnabled = useRef<boolean | undefined>(undefined);
  const allowed = useRef(active); allowed.current = active;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    if (!allowed.current || reading.current !== undefined || locked.current) return;
    const visit = ++generation.current;
    reading.current = visit;
    try {
      const next = await getObserver();
      if (mounted.current && allowed.current && visit === generation.current) {
        if (previousEnabled.current && !next.enabled) controlPlaneSession.clearPrivateViews();
        previousEnabled.current = next.enabled;
        setState(next); setError(false);
      }
    } catch { if (mounted.current && visit === generation.current) setError(true); }
    finally { if (reading.current === visit) reading.current = undefined; }
  }, []);
  useEffect(() => {
    if (!active) { generation.current++; setState(undefined); setError(false); return; }
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(() => void poll(), 5000); };
    void poll();
    return () => { stopped = true; generation.current++; clearTimeout(timer); };
  }, [active, refresh]);
  const update = async (action: ObserverAction) => {
    if (!allowed.current || locked.current) return;
    locked.current = true; reading.current = undefined; setBusy(true); setError(false);
    const visit = ++generation.current;
    try { const result = await updateObserver(action); if (mounted.current && allowed.current && visit === generation.current) return result; }
    catch { if (mounted.current && visit === generation.current) setError(true); }
    finally { locked.current = false; if (mounted.current) { setBusy(false); void refresh(); } }
  };
  return { state, busy, error, refresh, update };
}
export type ObserverSettingsState = ReturnType<typeof useObserver>;
