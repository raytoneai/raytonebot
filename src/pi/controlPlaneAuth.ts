import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { isLoopbackHostname } from "./requestOrigin.ts";

// Set only by the authenticated cloud middleware; HTTP headers cannot carry this property.
export const CLOUD_CONTROL_CONTEXT = Symbol.for("raytonebot.trusted-cloud-control-context.v1");
export type CloudControlContext = { principal: string; publicOrigin: string };
export function cloudControlContext(req: IncomingMessage): CloudControlContext | undefined {
  return (req as IncomingMessage & { [CLOUD_CONTROL_CONTEXT]?: CloudControlContext })[CLOUD_CONTROL_CONTEXT];
}
export type ControlAuthorization = { requestedBy: "user_session"; authorizedVia: string; scope: "user" | "developer"; version: 1; at: number };
export class ControlAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 401) { super(code === "control_auth_unavailable" ? "Control authorization storage unavailable." : code === "control_developer_required" ? "Enable developer access in Settings." : code === "control_csrf_invalid" ? "Refresh authorization before saving." : "Open RaytoneBot from the host authorization entry."); this.code = code; this.status = status; }
}
const COOKIE = "raytone_control";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
type Session = { id: string; csrfToken: string; expiresAt: number; origin: string; cloudPrincipal?: string; developerScope: boolean; developerRevision: number; expiryTimer?: ReturnType<typeof setTimeout>; responses: Set<{ res: ServerResponse; developer: boolean }> };
export function createControlPlaneAuth(options: { dataDir: string; now?(): number; sessionTtlMs?: number; entryTtlMs?: number }) {
  const now = options.now ?? Date.now, ttl = options.sessionTtlMs ?? 30 * 60_000;
  const root = `${options.dataDir}.control-plane`, auditFile = join(root, "authorization.jsonl");
  const proofs = new WeakMap<ControlAuthorization, { session: Session; developerRevision: number }>();
  const revokedListeners = new Set<(event: { authorizedVia: string; scope: "user" | "developer" }) => void>();
  const notifyRevoked = (session: Session, scope: "user" | "developer") => { for (const listener of revokedListeners) try { listener({ authorizedVia: session.id, scope }); } catch { /* Authorization remains revoked when a consumer fails. */ } };
  const entries = new Map<string, { origin: string; expiresAt: number }>();
  const sessions = new Map<string, Session>(), expired = new Set<string>();
  const context = (req: IncomingMessage) => {
    const cloud = cloudControlContext(req);
    if (cloud) return { origin: cloud.publicOrigin, cloudPrincipal: cloud.principal };
    const host = req.headers.host;
    if (!host || !isLoopbackHostname(req.socket.remoteAddress ?? "")) throw new ControlAuthError("control_auth_required");
    let url: URL;
    try { url = new URL(`http://${host}`); } catch { throw new ControlAuthError("control_auth_required"); }
    if (!isLoopbackHostname(url.hostname) || url.username || url.password || url.pathname !== "/") throw new ControlAuthError("control_auth_required");
    return { origin: url.origin, cloudPrincipal: undefined };
  };
  const audit = (req: IncomingMessage, scope: string, accepted: boolean, reason: string, authorization?: ControlAuthorization) => {
    // Fixed route categories and host metadata only; no query, body, cookie, or caller-supplied identity.
    const pathname = (req.url ?? "/").split("?")[0];
    const category = pathname.split("/")[3] ?? "unknown";
    const route = /^(?:auth|health|routines|learning|providers|bots|usage|skills|files|documents|artifacts|state|config|prompt|group|conversations|abort|approval|input|session|channels|mcp|memory|vault|provider|permissions|browser)$/.test(category) ? category : "unknown";
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if ((statSync(auditFile, { throwIfNoEntry: false })?.size ?? 0) >= 2 * 1024 * 1024) renameSync(auditFile, `${auditFile}.1`);
      appendFileSync(auditFile, `${JSON.stringify({ at: now(), version: 1, decision: accepted ? "authorization_accepted" : "authorization_rejected", reason, scope, method: ["GET", "HEAD", "POST", "DELETE", "OPTIONS", "PUT", "PATCH"].includes(req.method ?? "") ? req.method : "unknown", route, ...(authorization ?? {}) })}\n`, { mode: 0o600 });
    } catch { if (accepted) throw new ControlAuthError("control_auth_unavailable", 503); }
  };
  const close = (session: Session, developerOnly = false) => {
    for (const item of session.responses) if (!developerOnly || item.developer) {
      if (!item.res.headersSent) {
        item.res.statusCode = developerOnly ? 403 : 401;
        item.res.setHeader("content-type", "application/json; charset=utf-8");
        item.res.setHeader("cache-control", "no-store");
        item.res.end(JSON.stringify({ error: "Control authorization is no longer valid.", code: developerOnly ? "control_developer_required" : "control_session_expired" }));
      } else item.res.end();
    }
  };
  const retire = (key: string, session: Session) => { if (!sessions.delete(key)) return; if (session.expiryTimer) clearTimeout(session.expiryTimer); notifyRevoked(session, "user"); expired.add(key); if (expired.size > 64) expired.delete(expired.values().next().value!); close(session); };
  const find = (req: IncomingMessage): { key: string; session: Session } => {
    const cookie = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!cookie || cookie.length > 200) throw new ControlAuthError("control_auth_required");
    const key = digest(cookie), session = sessions.get(key);
    if (!session) throw new ControlAuthError(expired.has(key) ? "control_session_expired" : "control_auth_required");
    if (session.expiresAt <= now()) { retire(key, session); throw new ControlAuthError("control_session_expired"); }
    const current = context(req);
    if (current.origin !== session.origin || current.cloudPrincipal !== session.cloudPrincipal) { retire(key, session); throw new ControlAuthError("control_auth_required"); }
    return { key, session };
  };
  const view = (session: Session) => ({ authenticated: true as const, csrfToken: session.csrfToken, expiresAt: session.expiresAt, developerScope: session.developerScope });
  const metadata = (session: Session, developer: boolean): ControlAuthorization => ({ requestedBy: "user_session", authorizedVia: session.id, scope: developer ? "developer" : "user", version: 1, at: now() });
  const check = (req: IncomingMessage, developer = false) => {
    try {
      const found = find(req);
      if (!["GET", "HEAD"].includes(req.method ?? "") && (typeof req.headers["x-raytonebot-csrf"] !== "string" || !equal(req.headers["x-raytonebot-csrf"], found.session.csrfToken))) throw new ControlAuthError("control_csrf_invalid", 403);
      if (developer && !found.session.developerScope) throw new ControlAuthError("control_developer_required", 403);
      return found;
    } catch (error) { audit(req, developer ? "developer" : "user", false, error instanceof ControlAuthError ? error.code : "control_auth_required"); throw error; }
  };
  return {
    root,
    issueEntry(origin: string): string {
      const url = new URL(origin);
      if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.origin !== origin) throw new Error("Local authorization entry requires a bare loopback HTTP origin.");
      const value = secret(); entries.clear(); entries.set(digest(value), { origin, expiresAt: now() + (options.entryTtlMs ?? 120_000) }); return value;
    },
    exchange(req: IncomingMessage, res: ServerResponse, value: unknown) {
      const current = context(req), cloud = Boolean(current.cloudPrincipal), key = typeof value === "string" ? digest(value) : "", entry = entries.get(key);
      if (!cloud && (!entry || entry.expiresAt <= now() || entry.origin !== current.origin)) { audit(req, "user", false, "control_auth_required"); throw new ControlAuthError("control_auth_required"); }
      const session: Session = { id: randomUUID(), csrfToken: secret(), expiresAt: now() + ttl, ...current, developerScope: false, developerRevision: 0, responses: new Set() };
      audit(req, "user", true, "session_exchange", metadata(session, false));
      if (!cloud) entries.delete(key);
      // Explicit reauthorization replaces this browser's old session; GET never reauthorizes.
      try { const previous = find(req); retire(previous.key, previous.session); } catch { /* No existing valid session. */ }
      for (const [oldKey, old] of sessions) if (old.expiresAt <= now()) retire(oldKey, old);
      if (sessions.size >= 32) { const [oldKey, old] = sessions.entries().next().value!; retire(oldKey, old); }
      const token = secret(), sessionKey = digest(token); sessions.set(sessionKey, session);
      session.expiryTimer = setTimeout(() => retire(sessionKey, session), Math.max(1, session.expiresAt - now())); session.expiryTimer.unref();
      res.setHeader("set-cookie", `${COOKIE}=${token}; Path=/__agentcanvas/pi; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}${cloud ? "; Secure" : ""}`);
      return view(session);
    },
    session(req: IncomingMessage) { return view(check(req).session); },
    recheck(req: IncomingMessage, developer = false, authorization?: ControlAuthorization) {
      const { session } = check(req, developer), proof = authorization && proofs.get(authorization);
      if (authorization && (!proof || proof.session !== session || developer && proof.developerRevision !== session.developerRevision)) throw new ControlAuthError(developer ? "control_developer_required" : "control_auth_required", 403);
    },
    authorize(req: IncomingMessage, res: ServerResponse, developer = false): ControlAuthorization {
      const { session } = check(req, developer), authorization = metadata(session, developer);
      audit(req, authorization.scope, true, "session_valid", authorization);
      proofs.set(authorization, { session, developerRevision: session.developerRevision });
      const item = { res, developer }; session.responses.add(item);
      res.once("close", () => { session.responses.delete(item); });
      return authorization;
    },
    changeDeveloper(req: IncomingMessage, enabled: boolean) {
      const { session } = check(req); audit(req, "developer", true, enabled ? "developer_granted" : "developer_revoked", metadata(session, false));
      session.developerScope = enabled; session.developerRevision++;
      if (!enabled) { notifyRevoked(session, "developer"); close(session, true); }
      return view(session);
    },
    logout(req: IncomingMessage, res: ServerResponse) {
      const { key, session } = check(req); audit(req, "user", true, "session_revoked", metadata(session, false));
      res.setHeader("set-cookie", `${COOKIE}=; Path=/__agentcanvas/pi; HttpOnly; SameSite=Strict; Max-Age=0${session.cloudPrincipal ? "; Secure" : ""}`);
      // Do not close this logout response before its acknowledgement.
      for (const item of session.responses) if (item.res === res) session.responses.delete(item);
      retire(key, session);
      return { authenticated: false };
    },
    auditCloudRead(req: IncomingMessage) { audit(req, "user", true, "cloud_ingress_read", { requestedBy: "user_session", authorizedVia: "cloud_ingress", scope: "user", version: 1, at: now() }); },
    onRevoked(listener: (event: { authorizedVia: string; scope: "user" | "developer" }) => void) { revokedListeners.add(listener); return () => revokedListeners.delete(listener); },
    dispose() { for (const [key, session] of sessions) retire(key, session); revokedListeners.clear(); entries.clear(); expired.clear(); },
  };
}
export type ControlPlaneAuth = ReturnType<typeof createControlPlaneAuth>;
