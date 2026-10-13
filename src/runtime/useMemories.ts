import { useCallback, useEffect, useState } from "react";

import { deleteMemory, getMemories, saveMemory, setMemoryEnabled } from "../pi/piClient";
import type { MemoryState } from "../pi/memoryTypes";

export type MemoriesState = {
  memory?: MemoryState;
  error?: string;
  /** The memory being saved or deleted; `"new"` while adding, `"settings"` while switching. */
  busy?: string;
  actionError?: { id: string; message: string };
  /** Resolves true once saved; a failure stays on `actionError`. */
  save(id: string | undefined, text: string): Promise<boolean>;
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

  const load = useCallback(() => getMemories().then((value) => {
    setMemory(value);
    setError(undefined);
  }, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))), []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const act = useCallback(async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setActionError(undefined);
    try {
      await action();
      await load();
      return true;
    } catch (failure) {
      setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
      return false;
    } finally {
      setBusy(undefined);
    }
  }, [load]);

  return {
    memory, error, busy, actionError,
    save: (id, text) => act(id ?? "new", () => saveMemory(id, text)),
    remove: async (id) => { await act(id, () => deleteMemory(id)); },
    setEnabled: async (enabled) => { await act("settings", () => setMemoryEnabled(enabled)); },
  };
}
