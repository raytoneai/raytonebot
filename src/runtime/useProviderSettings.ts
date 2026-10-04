import { useEffect, useState } from "react";
import type { AgentFrontendProject } from "../schema/agentuxConfig";
import { PROVIDER_SETTINGS_KEY, restoreProviderSettings, serializeProviderSettings } from "./providerSettings";

export type ProviderSettingsStatus = "idle" | "saved" | "load-failed" | "save-failed";

export function useProviderSettings(base: AgentFrontendProject) {
  const [initial] = useState(() => {
    try {
      const raw = window.localStorage.getItem(PROVIDER_SETTINGS_KEY);
      return { project: { ...base, providers: restoreProviderSettings(base.providers, raw) }, status: raw ? "saved" : "idle" } as const;
    } catch { return { project: base, status: "load-failed" } as const; }
  });
  const [project, setProject] = useState(initial.project);
  const [status, setStatus] = useState<ProviderSettingsStatus>(initial.status);
  useEffect(() => {
    // Loading defaults (including recovery from invalid storage) is never a user edit.
    if (project.providers === initial.project.providers) return;
    try {
      window.localStorage.setItem(PROVIDER_SETTINGS_KEY, serializeProviderSettings(base.providers, project.providers));
      setStatus("saved");
    } catch { setStatus("save-failed"); }
  }, [base.providers, initial.project.providers, project.providers]);
  return { project, setProject, status };
}
