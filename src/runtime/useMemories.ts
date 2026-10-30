import { useCallback, useEffect, useRef, useState } from "react";

import { deleteMemory, getMemories, saveMemory, setMemoryEnabled } from "../pi/piClient";
import type { MemoryScope, MemoryState } from "../pi/memoryTypes";

export type MemoriesState = {
  memory?: MemoryState;
  error?: string;
  /** The memory being saved or deleted; `"new"` while adding, `"settings"` while switching. */
  busy?: string;
  actionError?: { id: string; message: string };
  /** Resolves true once saved; a failure stays on `actionError`. */
  save(id: string | undefined, text: string, scope?: MemoryScope): Promise<boolean>;
  remove(id: string): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
};

/** Cross-conversation memory (ADR-038), read from the host while the settings page is open.
 *  Polled there: agents save memories from chat while it may be open. */
export function useMemories(active: boolean): MemoriesState {
  const [memory, setMemory] = useState<MemoryState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<MemoriesState["actionError"]>();
  const locked = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  const load = useCallback(async (afterAction = false) => {
    if (!mounted.current || (locked.current && !afterAction)) return;
    const request = ++generation.current;
    try {
      const value = await getMemories();
      if (!mounted.current || request !== generation.current) return;
      setMemory(value);
      setError(undefined);
    } catch (failure) {
      if (mounted.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await load();
      if (!stopped) timer = window.setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [active, load]);

  const act = useCallback(async (id: string, action: () => Promise<unknown>) => {
    if (locked.current || !mounted.current) return false;
    locked.current = true;
    generation.current++; // Reads started before this mutation cannot replace its result.
    setBusy(id);
    setActionError(undefined);
    try {
      await action();
      if (!mounted.current) return false;
      await load(true);
      return true;
    } catch (failure) {
      if (mounted.current) setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [load]);

  return {
    memory, error, busy, actionError,
    save: (id, text, scope) => act(id ?? "new", () => saveMemory(id, text, fetch, scope)),
    remove: async (id) => { await act(id, () => deleteMemory(id)); },
    setEnabled: async (enabled) => { await act("settings", () => setMemoryEnabled(enabled)); },
  };
}
