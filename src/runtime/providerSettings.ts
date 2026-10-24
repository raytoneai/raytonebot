import { isSafeProviderEnvVarName, type AgentFrontendProject, type ProviderConnection } from "../schema/agentuxConfig.ts";

type Providers = AgentFrontendProject["providers"];
type Fields = Pick<ProviderConnection, "baseUrl" | "defaultModel" | "models" | "enabled" | "added">;
export type ProviderPatch = Partial<Fields> & { authEnvVar?: string };
type Saved = { version: 1; defaultProviderId?: string; connections: (ProviderPatch & { id: string })[] };
export const PROVIDER_SETTINGS_KEY = "raytonebot.providerSettings";

const modelName = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
function validPatch(value: ProviderPatch): boolean {
  if (value.baseUrl !== undefined) {
    try {
      const url = new URL(value.baseUrl);
      if (value.baseUrl.length > 4096 || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    } catch { return false; }
  }
  return (value.enabled === undefined || typeof value.enabled === "boolean")
    && (value.added === undefined || typeof value.added === "boolean")
    && (value.defaultModel === undefined || modelName(value.defaultModel))
    && (value.models === undefined || (Array.isArray(value.models) && value.models.length <= 1000 && value.models.every(modelName)))
    && (value.authEnvVar === undefined || (typeof value.authEnvVar === "string" && isSafeProviderEnvVarName(value.authEnvVar)));
}

/** Restore only editable non-key fields onto the current project's known services. */
export function restoreProviderSettings(base: Providers, raw: string | null): Providers {
  if (raw === null) return base;
  if (raw.length > 128_000) throw new Error("Invalid provider settings");
  const saved = JSON.parse(raw) as Saved;
  if (!saved || saved.version !== 1 || !Array.isArray(saved.connections) || saved.connections.length > 100) throw new Error("Invalid provider settings");
  const connections = base.connections.map(provider => {
    const values = saved.connections.filter(item => item?.id === provider.id);
    if (!values.length) return provider;
    const { baseUrl, defaultModel, models, enabled, authEnvVar, added } = values[0];
    const patch = { baseUrl, defaultModel, models, enabled, authEnvVar, added };
    if (values.length > 1 || !validPatch(patch)) throw new Error("Invalid provider settings");
    return { ...provider, ...Object.fromEntries(Object.entries({ baseUrl, defaultModel, models, enabled }).filter(([, v]) => v !== undefined)),
      ...(added !== undefined ? { added } : Object.values(patch).some(value => value !== undefined) ? { added: true } : {}),
      auth: authEnvVar !== undefined && provider.auth.mode === "env" ? { ...provider.auth, envVar: authEnvVar } : provider.auth };
  });
  const enabled = connections.filter(provider => provider.enabled);
  if (!enabled.length) throw new Error("No enabled model service");
  const preferred = saved.defaultProviderId ?? base.defaultProviderId;
  return { ...base, connections, defaultProviderId: enabled.find(provider => provider.id === preferred)?.id
    ?? enabled.find(provider => provider.id === base.defaultProviderId)?.id ?? enabled[0].id };
}

/** Save differences only: deployment defaults still apply to fields the user never changed. */
export function serializeProviderSettings(base: Providers, current: Providers): string {
  const saved: Saved = { version: 1, connections: [] };
  if (current.defaultProviderId !== base.defaultProviderId) saved.defaultProviderId = current.defaultProviderId;
  for (const original of base.connections) {
    const provider = current.connections.find(item => item.id === original.id);
    if (!provider) continue;
    const patch: ProviderPatch = {};
    for (const key of ["baseUrl", "defaultModel", "models", "enabled", "added"] as const) {
      if (JSON.stringify(provider[key]) !== JSON.stringify(original[key])) Object.assign(patch, { [key]: provider[key] });
    }
    if (provider.auth.mode === "env" && provider.auth.envVar !== original.auth.envVar) patch.authEnvVar = provider.auth.envVar;
    if (!validPatch(patch)) throw new Error("Invalid provider settings");
    if (Object.keys(patch).length) saved.connections.push({ id: provider.id, ...patch });
  }
  const raw = JSON.stringify(saved);
  restoreProviderSettings(base, raw); // The saved profile must also be restorable.
  return raw;
}

export const providerIsAdded = (provider: ProviderConnection): boolean => provider.enabled || provider.added === true;

/** Trim committed identifiers so runtime selection checks compare the same values. */
export function normalizeProviderSettings(providers: Providers): Providers {
  return { ...providers, connections: providers.connections.map(provider => ({
    ...provider, baseUrl: provider.baseUrl.trim(), defaultModel: provider.defaultModel.trim(),
    models: [...new Set(provider.models.map(model => model.trim()).filter(Boolean))],
  })) };
}

/** Pure draft updates; credentials never become fields in a saved provider. */
export function updateProviderSettings(providers: Providers, id: string, patch: ProviderPatch): Providers {
  const { authEnvVar, ...fields } = patch;
  return { ...providers, connections: providers.connections.map(provider => provider.id !== id ? provider : {
    ...provider, ...fields,
    auth: authEnvVar !== undefined && provider.auth.mode === "env" ? { ...provider.auth, envVar: authEnvVar } : provider.auth,
  }) };
}

export function providerValidationIssue(provider: ProviderConnection): "baseUrl" | "defaultModel" | "authEnvVar" | undefined {
  if (!validPatch({ baseUrl: provider.baseUrl })) return "baseUrl";
  if (!validPatch({ defaultModel: provider.defaultModel })) return "defaultModel";
  if (provider.auth.mode === "env" && (!provider.auth.envVar || !validPatch({ authEnvVar: provider.auth.envVar }))) return "authEnvVar";
  return undefined;
}
