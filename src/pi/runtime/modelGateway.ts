import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gatewayPort } from "./agentProcess.ts";

// The limits are a safety net, not a verdict on the task: say how to continue.
const BUDGET_MESSAGE = "This turn reached its model request limit (RAYTONEBOT_RUN_MODEL_REQUESTS). Work so far is kept; send \"continue\" to resume.";
const DURATION_MESSAGE = "This turn reached its time limit (RAYTONEBOT_RUN_TIMEOUT_MS). Work so far is kept; send \"continue\" to resume.";
const PACKAGE_HOSTS = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];
type LeaseInput = {
  baseUrl: string; apiKey: string; model: string; protocol: "openai" | "anthropic";
  maxRequests?: number; maxDurationMs?: number; onLimit?: (message: string) => void;
};
type Lease = LeaseInput & { requests: number; expires: number; active: Set<AbortController>; limited: boolean };

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  // IPv4-mapped, loopback, link-local and ULA addresses never qualify as global IPv6.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}

/** Inspect the first TLS record before opening a tunnel, so shared CDN IPs cannot change SNI. */
export function clientHelloServerName(record: Buffer): string | undefined {
  try {
    if (record[0] !== 22 || record[1] !== 3 || record[5] !== 1 || record.length !== 5 + record.readUInt16BE(3) || record.readUIntBE(6, 3) + 9 !== record.length) return;
    let offset = 43; // Record + handshake headers, ClientHello version and random.
    offset += 1 + record[offset];
    offset += 2 + record.readUInt16BE(offset);
    offset += 1 + record[offset];
    const end = offset + 2 + record.readUInt16BE(offset);
    if (end !== record.length) return;
    offset += 2;
    let serverName: string | undefined;
    while (offset + 4 <= end) {
      const type = record.readUInt16BE(offset), length = record.readUInt16BE(offset + 2);
      offset += 4;
      if (offset + length > end || type === 0xfe0d) return; // No encrypted ClientHello bypass.
      if (type === 0) {
        if (serverName !== undefined) return;
        if (record[offset + 2] !== 0 || record.readUInt16BE(offset) !== length - 2) return;
        const size = record.readUInt16BE(offset + 3);
        if (size !== length - 5) return;
        serverName = record.subarray(offset + 5, offset + 5 + size).toString("ascii").toLowerCase();
      }
      offset += length;
    }
    return offset === end ? serverName : undefined;
  } catch { return; }
}

function reply(res: ServerResponse, code: number, message: string) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: { message } }));
}

/** The bot owns this loopback listener; agents get a revocable lease, never an upstream key. */
export async function createModelGateway(options: {
  port?: number; packageHosts?: readonly string[]; fetcher?: typeof fetch;
} = {}) {
  const leases = new Map<string, Lease>();
  const sockets = new Set<import("node:net").Socket>();
  const packageHosts = new Set(options.packageHosts ?? PACKAGE_HOSTS);
  const fetcher = options.fetcher ?? fetch;
  const limit = (lease: Lease, message: string) => {
    if (!lease.limited) { lease.limited = true; try { lease.onLimit?.(message); } catch { /* Reporting must not bypass a hard limit. */ } }
    for (const active of lease.active) active.abort();
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : req.headers["x-api-key"];
    const lease = typeof token === "string" ? leases.get(token) : undefined;
    if (!lease) return reply(res, 401, "Invalid or expired model lease.");
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const suffix = requestUrl.pathname.slice("/model".length);
    const allowed = lease.protocol === "anthropic" ? /^\/(?:v1\/)?messages(?:\/count_tokens)?$/ : /^\/(?:v1\/)?(?:chat\/completions|responses)$/;
    const allowedQuery = !requestUrl.search || (lease.protocol === "anthropic" && requestUrl.search === "?beta=true");
    if (req.method !== "POST" || !req.url?.startsWith("/model/") || !allowed.test(suffix) || !allowedQuery) return reply(res, 403, "Model route is not allowed.");
    if (lease.limited || Date.now() >= lease.expires || lease.requests >= (lease.maxRequests ?? 100)) {
      limit(lease, BUDGET_MESSAGE);
      return reply(res, 429, "Model request or duration budget exhausted.");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return reply(res, 413, "Model request is too large.");
      chunks.push(Buffer.from(chunk));
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return reply(res, 400, "Invalid model request."); }
    if (!body || typeof body !== "object" || body.model !== lease.model || body.background === true) return reply(res, 403, "Model is not allowed by this lease.");
    if (typeof token !== "string" || leases.get(token) !== lease) return reply(res, 401, "Invalid or expired model lease.");
    // Check again after reading the body: parallel uploads cannot overrun a lease's request cap.
    if (lease.limited || Date.now() >= lease.expires || lease.requests >= (lease.maxRequests ?? 100)) {
      limit(lease, BUDGET_MESSAGE);
      return reply(res, 429, "Model request or duration budget exhausted.");
    }
    // Token counting is bookkeeping, not a model step; only generations spend the budget.
    if (!suffix.endsWith("/count_tokens")) lease.requests += 1;
    const controller = new AbortController();
    lease.active.add(controller);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnected);
    const timer = setTimeout(() => { limit(lease, DURATION_MESSAGE); }, Math.max(1, lease.expires - Date.now()));
    timer.unref();
    try {
      const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${lease.apiKey}` };
      if (lease.protocol === "anthropic") {
        headers["x-api-key"] = lease.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        if (typeof req.headers["anthropic-beta"] === "string") headers["anthropic-beta"] = req.headers["anthropic-beta"];
      }
      const upstream = await fetcher(`${lease.baseUrl.replace(/\/$/, "")}${suffix}${requestUrl.search}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "manual",
      });
      if (controller.signal.aborted) { await upstream.body?.cancel(); if (!res.destroyed) reply(res, 401, "Model lease ended."); return; }
      // Never follow a provider redirect with the bot's key or send upstream cookies to an agent.
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return reply(res, 502, "Model provider redirects are disabled."); }
      if (upstream.status >= 400) {
        await upstream.body?.cancel();
        return reply(res, upstream.status, `Model provider returned HTTP ${upstream.status}.`);
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res);
      else res.end();
    } catch {
      if (!res.headersSent) reply(res, 502, "Model gateway request failed.");
      else res.destroy();
    } finally { clearTimeout(timer); lease.active.delete(controller); res.removeListener("close", disconnected); }
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 400, "Invalid gateway request."); else res.destroy(); }); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("connect", (req, socket, head) => {
    socket.on("error", () => {}); // A client may reset while DNS or the upstream connection is pending.
    void (async () => {
      const match = /^([a-z0-9.-]+):443$/i.exec(req.url ?? "");
      if (!match || !packageHosts.has(match[1].toLowerCase())) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const hello = await new Promise<Buffer>((resolve, reject) => {
        let pending = head;
        const timer = setTimeout(() => finish(new Error("TLS handshake timed out.")), 10_000);
        const finish = (error?: Error) => {
          clearTimeout(timer); socket.removeListener("data", data); socket.removeListener("error", finish); socket.removeListener("close", closed);
          if (error) reject(error); else { socket.pause(); resolve(pending); }
        };
        const closed = () => finish(new Error("Tunnel closed."));
        const data = (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > 65540) return finish(new Error("TLS handshake too large."));
          if (pending.length >= 5 && (pending[0] !== 22 || pending[1] !== 3)) return finish(new Error("TLS required."));
          if (pending.length >= 5 && pending.length >= 5 + pending.readUInt16BE(3)) {
            if (clientHelloServerName(pending.subarray(0, 5 + pending.readUInt16BE(3))) !== match[1].toLowerCase()) return finish(new Error("TLS hostname does not match tunnel."));
            finish();
          }
        };
        socket.on("data", data); socket.once("error", finish); socket.once("close", closed); data(Buffer.alloc(0));
      });
      const addresses = await lookup(match[1], { all: true });
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("Private package address.");
      // Connect to the checked IP, not to the hostname a second time (DNS rebinding).
      const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
      const upstream = connect({ host: address.address, family: address.family, port: 443 });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.once("connect", () => { upstream.write(hello); socket.pipe(upstream); upstream.pipe(socket); socket.resume(); });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? gatewayPort(), "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    issue(input: LeaseInput) {
      const url = new URL(input.baseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Model upstream must be an HTTPS base URL without credentials or query.");
      if (!input.apiKey || !input.model || (input.maxRequests !== undefined && (!Number.isInteger(input.maxRequests) || input.maxRequests < 1))
        || (input.maxDurationMs !== undefined && (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0))) throw new Error("Invalid model lease.");
      const token = randomBytes(32).toString("base64url");
      const lease: Lease = { ...input, requests: 0, expires: Date.now() + (input.maxDurationMs ?? 30 * 60_000), active: new Set(), limited: false };
      leases.set(token, lease);
      return { baseUrl: `http://127.0.0.1:${port}/model`, apiKey: token, revoke() { leases.delete(token); for (const active of lease.active) active.abort(); } };
    },
    async close() { for (const lease of leases.values()) for (const active of lease.active) active.abort(); leases.clear(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
