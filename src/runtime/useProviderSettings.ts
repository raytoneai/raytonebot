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
  useEffect(() => {
    let active = true;
    void getProviderSettings().then(view => {
      if (!active) return;
      host.current = view; setSaved(view);
      // Legacy browser preferences are imported only by the user's explicit Save.
      if (view.providers) { setProject(current => ({ ...current, providers: view.providers! })); setStatus("saved"); }
    }).catch(() => { if (active) setStatus("load-failed"); });
    return () => { active = false; };
  }, []);
  async function saveProviders(providers: AgentFrontendProject["providers"], keys: Record<string, string> = {}, removeKeys: string[] = []) {
    try {
      if (!host.current) throw new Error("Provider settings have not loaded. Reload before saving.");
      const view = await saveProviderSettings({ providers, keys, removeKeys, revision: host.current.revision });
      host.current = view; setSaved(view);
      setProject(current => ({ ...current, providers: view.providers! }));
      setStatus("saved");
      try { window.localStorage.removeItem(PROVIDER_SETTINGS_KEY); } catch { /* Host is authoritative. */ }
    } catch (error) {
      setStatus("save-failed");
      if (error instanceof PiRequestError && error.status === 409) {
        try {
          const view = await getProviderSettings(); host.current = view; setSaved(view);
          if (view.providers) setProject(current => ({ ...current, providers: view.providers! }));
        } catch { /* Preserve the draft and report the original conflict. */ }
      }
      throw error;
    }
  }
  return { project, setProject, status, saveProviders, saved };
}
