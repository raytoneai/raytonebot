/** Origin is a CSRF check, never proof of user authorization. */
export function sameOriginRequestAllowed(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const rawOrigin = headerValue(req.headers.origin);
  if (!rawOrigin) return true;
  if (rawOrigin === "null") return false;

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  if (!isLoopbackHostname(origin.hostname)) return false;

  const hostHeader = headerValue(req.headers.host);
  if (!hostHeader) return false;
  const host = parseHostHeader(hostHeader);
  if (!host) return false;
  if (!isLoopbackHostname(host.hostname)) return false;

  const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
  const hostPort = host.port || (origin.protocol === "https:" ? "443" : "80");
  return origin.hostname === host.hostname && originPort === hostPort;
}

function parseHostHeader(value: string): { hostname: string; port?: string } | undefined {
  try {
    const url = new URL(`http://${value}`);
    return { hostname: url.hostname, port: url.port || undefined };
  } catch {
    return undefined;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return normalized === "::ffff:127.0.0.1" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
