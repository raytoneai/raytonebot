import { useCallback, useEffect, useRef, useState } from "react";

import { deleteMcpServer, listMcpServers, refreshMcpServer, saveMcpServer } from "../pi/piClient";
import type { McpServerInput, McpServerView } from "../pi/mcpTypes";

export type McpServersState = {
  servers?: McpServerView[];
  error?: string;
  /** The server being saved, tested or deleted; `"new"` while adding one. */
  busy?: string;
  actionError?: { id: string; message: string };
  /** Resolves true once saved; a failure stays on `actionError`. */
  save(id: string | undefined, input: McpServerInput): Promise<boolean>;
  refresh(id: string): Promise<void>;
  remove(id: string): Promise<void>;
};

/** MCP servers (ADR-037), read from the host when the settings page opens. */
export function useMcpServers(active: boolean): McpServersState {
  const [servers, setServers] = useState<McpServerView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<McpServersState["actionError"]>();
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
      const value = await listMcpServers();
      if (!mounted.current || request !== generation.current) return;
      setServers(value);
      setError(undefined);
    } catch (failure) {
      if (mounted.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
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
    servers, error, busy, actionError,
    save: (id, input) => act(id ?? "new", () => saveMcpServer(id, input)),
    refresh: async (id) => { await act(id, () => refreshMcpServer(id)); },
    remove: async (id) => { await act(id, () => deleteMcpServer(id)); },
  };
}
