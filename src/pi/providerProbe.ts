import type { PiProviderDefinition } from "./piClient.ts";

/**
 * Reach a provider's model list with its key: the settings page's "test" and "fetch models".
 * Registering a provider in Pi never touches the network, so without this a wrong key or URL
 * only surfaced on the first real prompt. Node-only.
 */
export type ProviderProbeResult = {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  models: string[];
  error?: string;
};

export function modelsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl.trim());
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Provider URL must use HTTPS (plain HTTP is allowed for localhost only).");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url;
}

export async function probeProvider(
  definition: Pick<PiProviderDefinition, "baseUrl" | "protocol">,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<ProviderProbeResult> {
  let url: URL;
  try {
    url = modelsUrl(definition.baseUrl);
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    if (definition.protocol === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }
  const started = Date.now();
  try {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(10_000) });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, status: response.status, latencyMs, models: [], error: `HTTP ${response.status}` };
    }
    const body = await response.json().catch(() => ({})) as { data?: unknown };
    const models = Array.isArray(body.data)
      ? body.data.map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return { ok: true, status: response.status, latencyMs, models };
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Timed out after 10 s."
      : error instanceof Error ? error.message : String(error);
    return { ok: false, latencyMs: Date.now() - started, models: [], error: message };
  }
}
