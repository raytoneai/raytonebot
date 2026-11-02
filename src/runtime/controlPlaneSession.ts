const AUTH_PREFIX = "/__agentcanvas/pi/auth";
export const CONTROL_CSRF_HEADER = "x-raytonebot-csrf";
export type ControlPlaneSessionState = {
  enabled: boolean;
  authenticated: boolean;
  developerScope: boolean;
  expiresAt?: number;
  code?: string;
  epoch: number;
};
type SessionReceipt = { authenticated: true; csrfToken: string; expiresAt: number; developerScope: boolean };

/** Consume before mounting anything that can request host data. Never retain the entry URL. */
export function consumeControlPlaneEntry(location: Pick<Location, "href">, history: Pick<History, "replaceState" | "state">): string | undefined {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has("control-plane")) return undefined;
  const secret = fragment.get("control-plane") ?? "";
  fragment.delete("control-plane");
  url.hash = fragment.toString();
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return secret;
}

/** Cookie stays HttpOnly; only the CSRF proof and authorization status live in this page. */
export class ControlPlaneSession {
  private state: ControlPlaneSessionState = { enabled: false, authenticated: false, developerScope: false, epoch: 0 };
  private csrfToken?: string;
  private generation = 0;
  private ready: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private expiry?: ReturnType<typeof setTimeout>;
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (...args) => fetch(...args)) { this.fetcher = fetcher; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ControlPlaneSessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private invalidate(code: string) {
    if (!this.state.authenticated && this.state.code === code) return;
    this.generation++;
    this.csrfToken = undefined;
    clearTimeout(this.expiry);
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.publish({ authenticated: false, developerScope: false, expiresAt: undefined, code, epoch: this.state.epoch + 1 });
  }
  private accept(body: SessionReceipt, replace = false) {
    if (body.authenticated !== true || typeof body.csrfToken !== "string" || !body.csrfToken || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) throw new Error("control_auth_required");
    const wasAuthenticated = this.state.authenticated;
    const revokedDeveloper = this.state.developerScope && body.developerScope !== true;
    if (revokedDeveloper || replace) { this.lifetime.abort(); this.lifetime = new AbortController(); }
    this.csrfToken = body.csrfToken;
    clearTimeout(this.expiry);
    this.publish({ authenticated: true, developerScope: body.developerScope === true, expiresAt: body.expiresAt, code: undefined,
      epoch: this.state.epoch + (!wasAuthenticated || revokedDeveloper || replace ? 1 : 0) });
    this.expiry = setTimeout(() => this.invalidate("control_session_expired"), Math.min(body.expiresAt - Date.now(), 2_147_483_647));
    this.expiry.unref?.();
  }
  initialize(secret?: string): Promise<void> {
    if (this.state.enabled) return this.ready;
    this.publish({ enabled: true });
    this.ready = this.sessionRequest(secret === undefined ? "/session" : "/exchange", secret === undefined ? undefined : { secret }).catch(error => {
      this.invalidate(error instanceof Error && error.message.startsWith("control_") ? error.message : "control_auth_unavailable");
    });
    return this.ready;
  }
  private async sessionRequest(path: string, body?: unknown) {
    const generation = ++this.generation;
    let response: Response;
    try { response = await this.fetcher(`${AUTH_PREFIX}${path}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }); }
    catch (error) { if (generation !== this.generation) return; throw error; }
    const receipt = await response.json().catch(error => { if (generation !== this.generation) return undefined; throw error; });
    if (generation !== this.generation) return;
    if (!response.ok) throw new Error(receipt.code ?? "control_auth_required");
    this.accept(receipt, path === "/exchange");
  }
  /** Explicitly exchange a trusted cloud entry. Local hosts still require their one-time URL. */
  async authorizeTrustedEntry() { await this.ready; await this.sessionRequest("/exchange", {}); }
  async changeDeveloperScope(grant: boolean) {
    const generation = ++this.generation;
    const response = await this.request(`${AUTH_PREFIX}/developer/${grant ? "grant" : "revoke"}`, { method: "POST" });
    const body = await response.json();
    if (generation !== this.generation) return;
    if (!response.ok) throw new Error(body.code ?? "control_auth_required");
    this.accept(body);
  }
  clearPrivateViews() {
    this.generation++; this.lifetime.abort(); this.lifetime = new AbortController();
    this.publish({ epoch: this.state.epoch + 1 });
  }
  async logout() {
    const generation = ++this.generation;
    const response = await this.request(`${AUTH_PREFIX}/logout`, { method: "POST" });
    if (generation !== this.generation) return;
    if (!response.ok) throw new Error("control_auth_required");
    this.invalidate("control_auth_required");
  }
  async request(url: RequestInfo | URL, init: RequestInit = {}, fetcher = this.fetcher): Promise<Response> {
    if (!this.state.enabled) return fetcher(url, { ...init, credentials: "same-origin" });
    await this.ready;
    init.signal?.throwIfAborted();
    if (this.state.expiresAt && this.state.expiresAt <= Date.now()) this.invalidate("control_session_expired");
    if (!this.state.authenticated) return Response.json({ error: this.state.code ?? "control_auth_required", code: this.state.code ?? "control_auth_required" }, { status: 401 });
    const headers = new Headers(init.headers);
    if (!["GET", "HEAD", "OPTIONS"].includes((init.method ?? "GET").toUpperCase())) headers.set(CONTROL_CSRF_HEADER, this.csrfToken!);
    const lifetime = this.lifetime.signal;
    const response = await fetcher(url, { ...init, headers, credentials: "same-origin", signal: init.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime });
    if ((response.status === 401 || response.status === 403) && lifetime === this.lifetime.signal) {
      const body = await response.clone().json().catch(() => ({}));
      if (lifetime !== this.lifetime.signal) return response;
      if (response.status === 401 || body.code === "control_csrf_invalid") this.invalidate(body.code ?? "control_auth_required");
      else if (body.code === "control_developer_required" && this.state.developerScope) {
        this.generation++;
        this.lifetime.abort(); this.lifetime = new AbortController();
        this.publish({ developerScope: false, epoch: this.state.epoch + 1 });
      }
    }
    return response;
  }
}
export const controlPlaneSession = new ControlPlaneSession();
export const controlPlaneFetch = (url: RequestInfo | URL, init?: RequestInit, fetcher?: typeof fetch) => controlPlaneSession.request(url, init, fetcher);
