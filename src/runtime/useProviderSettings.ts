import { useEffect, useRef, useState } from "react";
import type { AgentFrontendProject } from "../schema/agentuxConfig";
import { getProviderSettings, saveProviderSettings, PiRequestError, type ProviderSettingsView } from "../pi/piClient";
import { PROVIDER_SETTINGS_KEY, restoreProviderSettings } from "./providerSettings";

export type ProviderSettingsStatus = "idle" | "saved" | "load-failed" | "save-failed";

export function useProviderSettings(base: AgentFrontendProject) {
  const [project, setProject] = useState(() => {
    try { return { ...base, providers: restoreProviderSettings(base.providers, window.localStorage.getItem(PROVIDER_SETTINGS_KEY)) }; }
    catch { return base; }
  });
  const [status, setStatus] = useState<ProviderSettingsStatus>("idle");
  const [saved, setSaved] = useState<ProviderSettingsView>();
  const host = useRef<ProviderSettingsView>(undefined);
  function accept(view: ProviderSettingsView) {
    // An earlier read must not undo a configuration saved while it was in flight.
    if (host.current && view.revision < host.current.revision) return host.current.providers ?? project.providers;
    host.current = view; setSaved(view);
    if (view.providers) { setProject(current => ({ ...current, providers: view.providers! })); setStatus("saved"); }
    return view.providers ?? project.providers;
  }
  async function syncProviders() {
    try { return accept(await getProviderSettings()); }
    catch (error) { setStatus("load-failed"); throw error; }
  }
  useEffect(() => {
    let active = true;
    void getProviderSettings().then(view => {
      if (!active) return;
      // Legacy browser preferences are imported only by the user's explicit Save.
      accept(view);
    }).catch(() => { if (active && !host.current) setStatus("load-failed"); });
    return () => { active = false; };
  }, []);
  async function saveProviders(providers: AgentFrontendProject["providers"], keys: Record<string, string> = {}, removeKeys: string[] = []) {
    try {
      if (!host.current) throw new Error("Provider settings have not loaded. Reload before saving.");
      const view = await saveProviderSettings({ providers, keys, removeKeys, revision: host.current.revision });
      accept(view);
      try { window.localStorage.removeItem(PROVIDER_SETTINGS_KEY); } catch { /* Host is authoritative. */ }
    } catch (error) {
      if (error instanceof PiRequestError && error.status === 409) {
        try {
          await syncProviders();
        } catch { /* Preserve the draft and report the original conflict. */ }
      }
      setStatus("save-failed");
      throw error;
    }
  }
  return { project, setProject, status, saveProviders, syncProviders, saved };
}
