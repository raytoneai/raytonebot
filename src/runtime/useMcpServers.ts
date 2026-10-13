import { useCallback, useEffect, useState } from "react";

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

  const load = useCallback(() => listMcpServers().then((value) => {
    setServers(value);
    setError(undefined);
  }, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))), []);

  useEffect(() => {
    if (active) void load();
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
    servers, error, busy, actionError,
    save: (id, input) => act(id ?? "new", () => saveMcpServer(id, input)),
    refresh: async (id) => { await act(id, () => refreshMcpServer(id)); },
    remove: async (id) => { await act(id, () => deleteMcpServer(id)); },
  };
}
