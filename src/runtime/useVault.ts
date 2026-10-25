import { useCallback, useEffect, useRef, useState } from "react";

import { deleteVault, getVault, saveVault } from "../pi/piClient";
import type { VaultLoginInput, VaultState } from "../pi/vaultTypes";

export type VaultSettingsState = {
  state?: VaultState;
  error?: string;
  busy?: string;
  actionError?: { id: string; message: string };
  refresh(): Promise<void>;
  save(input: VaultLoginInput): Promise<boolean>;
  remove(id: string): Promise<boolean>;
};

/** Only public metadata lives here. Secret drafts belong to the open settings editor. */
export function useVault(active: boolean): VaultSettingsState {
  const [state, setState] = useState<VaultState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<VaultSettingsState["actionError"]>();
  const current = useRef<VaultState | undefined>(undefined);
  const locked = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const accept = useCallback((value: VaultState) => {
    if (!mounted.current || (current.current && value.revision < current.current.revision)) return;
    current.current = value;
    setState(value);
    setError(undefined);
  }, []);
  const refresh = useCallback(async () => {
    if (locked.current) return;
    const request = ++generation.current;
    try {
      const value = await getVault();
      if (request === generation.current) accept(value);
    } catch (failure) {
      if (mounted.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [accept]);
  useEffect(() => {
    if (active) void refresh();
    return () => { generation.current++; };
  }, [active, refresh]);
  const act = useCallback(async (id: string, action: (revision: number) => Promise<VaultState>) => {
    if (locked.current || !current.current) return false;
    locked.current = true;
    generation.current++; // A previous read must never overwrite this mutation.
    setBusy(id);
    setActionError(undefined);
    try {
      accept(await action(current.current.revision));
      return true;
    } catch (failure) {
      if (mounted.current) setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
      // Refresh the revision after conflicts; keep the editor's unsaved draft for retry.
      try { accept(await getVault()); } catch { /* The original action error remains visible. */ }
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [accept]);
  return {
    state, error, busy, actionError, refresh,
    save: (input) => act(input.id ?? "new", (revision) => saveVault(input, revision)),
    remove: (id) => act(id, (revision) => deleteVault(id, revision)),
  };
}
