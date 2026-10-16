/**
 * The AgentSphere (E2B fork) REST calls the control service needs, ported from
 * scripts/agentsphere/sandbox.py `api()`. The team key stays in this process's environment.
 */

export const MAX_TIMEOUT_S = 50 * 3600; // "Timeout cannot be greater than 50 hours"

export type SandboxInfo = { state: "running" | "paused" | "unknown"; endAt?: number };

export type Platform = {
  create(template: string, timeoutS: number): Promise<string>;
  info(id: string): Promise<SandboxInfo | undefined>;
  resume(id: string, timeoutS: number): Promise<void>;
  /** Sets the end to now + `timeoutS`; only for a running sandbox. */
  renew(id: string, timeoutS: number): Promise<void>;
};

export class PlatformError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function agentSphere(apiKey: string, base = "https://api.agentsphere.run"): Platform {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  };
  const clamp = (seconds: number) => Math.max(60, Math.min(MAX_TIMEOUT_S, Math.round(seconds)));
  return {
    async create(template, timeoutS) {
      // Pause at the timeout instead of being destroyed; set only at creation (issue.md #1).
      const { status, body } = await call("POST", "/sandboxes", { templateID: template, timeout: clamp(timeoutS),
        autoPause: true, autoResume: { enabled: true } });
      if (status >= 300 || typeof body?.sandboxID !== "string") throw new PlatformError(`create: HTTP ${status}`, status);
      return body.sandboxID;
    },
    async info(id) {
      const { status, body } = await call("GET", `/sandboxes/${encodeURIComponent(id)}`);
      if (status === 404) return undefined;
      if (status !== 200 || !body) throw new PlatformError(`info: HTTP ${status}`, status);
      const state = body.state === "running" || body.state === "paused" ? body.state : "unknown";
      const endAt = typeof body.endAt === "string" ? Date.parse(body.endAt) : NaN;
      return { state, endAt: Number.isFinite(endAt) ? endAt : undefined };
    },
    async resume(id, timeoutS) {
      const { status } = await call("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, { timeout: clamp(timeoutS) });
      if (status >= 300) throw new PlatformError(`resume: HTTP ${status}`, status);
    },
    async renew(id, timeoutS) {
      const { status } = await call("POST", `/sandboxes/${encodeURIComponent(id)}/timeout`, { timeout: clamp(timeoutS) });
      if (status >= 300) throw new PlatformError(`renew: HTTP ${status}`, status);
    },
  };
}

export const botOrigin = (sandboxId: string) => `https://5188-${sandboxId}.agentsphere.run`;

/** Reads a bot route with its Basic credentials; undefined when the bot is not answering. */
export async function botGet(origin: string, password: string, path: string): Promise<unknown> {
  try {
    const response = await fetch(origin + path, {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Basic ${Buffer.from(`raytonebot:${password}`).toString("base64")}` },
    });
    return response.status === 200 ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}
