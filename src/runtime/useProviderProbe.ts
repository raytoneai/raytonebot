import { useEffect, useRef, useState } from "react";
import { testProviderConnection, type ProviderTestResult } from "../pi/piClient";
import { piRuntimeConfigurationForProvider } from "../pi/piProviderSync";
import type { ProviderConnection } from "../schema/agentuxConfig";
import type { ProviderPatch } from "./providerSettings";

/** A late result belongs to the credentials/address it tested, never the edited row. */
export function useProviderProbe(provider: ProviderConnection, sessionKey: string, onUpdate: (patch: ProviderPatch) => void, revision = 0) {
  const [test, setTest] = useState<ProviderTestResult | "running">();
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    setTest(undefined);
    return () => { pending.current?.abort(); pending.current = undefined; };
  }, [provider.id, provider.baseUrl, provider.protocol, provider.auth.mode, provider.auth.envVar, provider.enabled, sessionKey, revision]);

  async function runTest(updateModels = true) {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setTest("running");
    try {
      const definition = piRuntimeConfigurationForProvider(provider).providerDefinition!;
      const result = await testProviderConnection(definition, sessionKey || undefined, fetch, request.signal);
      if (request.signal.aborted) return;
      setTest(result);
      // Fetching choices must never change the user's selected model.
      if (result.ok && updateModels) onUpdate({ models: result.models });
    } catch (error) {
      if (!request.signal.aborted) setTest({ ok: false, models: [], error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (pending.current === request) pending.current = undefined;
    }
  }
  return { test, runTest };
}
