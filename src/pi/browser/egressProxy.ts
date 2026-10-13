import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, isIP, type Socket } from "node:net";

import { isPublicAddress } from "../runtime/modelGateway.ts";

/**
 * The browser's only way out (ADR-040): an HTTP proxy on loopback that reaches public addresses
 * on ports 80 and 443 and nothing else. Every address a name resolves to must be public, and the
 * connection goes to one of those checked addresses, so DNS rebinding cannot reach the sandbox's
 * own ports, the metadata service or a private network. In the sandbox the firewall lets the
 * browser UID talk to this port only; locally it is the browser's `--proxy-server`.
 */

const PORTS = new Set([80, 443]);
const MAX_SOCKETS = 256;
const IDLE_MS = 120_000;
const REFUSED = "RaytoneBot's browser reaches public websites on ports 80 and 443 only; this address was refused.";

export type EgressProxy = { port: number; close(): Promise<void> };

export async function startEgressProxy(options: {
  port?: number;
  /** Local development behind a TUN proxy: its fake-IP DNS answers in 198.18.0.0/15. */
  proxyFakeIp?: boolean;
  /** Tests only: which addresses and ports count as reachable (a local test server). */
  allowAddress?: (address: string) => boolean;
  allowPort?: (port: number) => boolean;
  log?(event: string, fields: Record<string, unknown>): void;
} = {}): Promise<EgressProxy> {
  const allowed = options.allowAddress ?? ((address: string) => isPublicAddress(address) || (options.proxyFakeIp === true && /^198\.1[89]\./.test(address)));
  const portAllowed = options.allowPort ?? ((port: number) => PORTS.has(port));
  const sockets = new Set<Socket>();
  const deny = (host: string, port: number, reason: string) => options.log?.("browser.egress_denied", { host, port, reason });

  /** One checked address for `host`, or a reason it cannot be reached. */
  const resolve = (host: string) => new Promise<string>((done, fail) => {
    const name = host.replace(/^\[|\]$/g, "");
    if (isIP(name)) return allowed(name) ? done(name) : fail(new Error("private address"));
    dnsLookup(name, { all: true }, (error, addresses: LookupAddress[]) => {
      if (error || !addresses.length) return fail(new Error("unresolved"));
      if (addresses.some(({ address }) => !allowed(address))) return fail(new Error("resolves to a private address"));
      done(addresses[0].address);
    });
  });

  const track = (socket: Socket) => {
    if (sockets.size >= MAX_SOCKETS) { socket.destroy(); return false; }
    sockets.add(socket);
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return true;
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP arrives in absolute form: GET http://host/path.
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { res.writeHead(400).end(); return; }
    const port = Number(url.port || 80);
    if (url.protocol !== "http:" || (port !== 80 && !portAllowed(port))) { deny(url.hostname, port, "port"); res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(REFUSED); return; }
    resolve(url.hostname).then((address) => {
      const headers = { ...req.headers };
      for (const name of ["proxy-connection", "proxy-authorization", "connection", "keep-alive"]) delete headers[name];
      const upstream = httpRequest({ host: address, port, method: req.method, path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host }, timeout: IDLE_MS }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.on("timeout", () => upstream.destroy());
      req.pipe(upstream);
    }, (error: Error) => { deny(url.hostname, port, error.message); res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(REFUSED); });
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    if (!track(client)) return;
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    const host = match?.[1] ?? "", port = Number(match?.[2]);
    if (!match || !portAllowed(port)) { deny(host, port, "port"); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    resolve(host).then((address) => {
      const upstream = connect({ host: address, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      if (!track(upstream)) { client.destroy(); return; }
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    }, (error: Error) => { deny(host, port, error.message); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveListen());
  });
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}
