import assert from "node:assert/strict";

/** Real HTTP authentication for one explicitly selected fixture; never patches global fetch. */
export async function authenticatedFetch(host: { controlPlaneAuth: { issueEntry(origin: string): string } }, base: string, developer = false): Promise<typeof fetch & { headers: Record<string, string> }> {
  const origin = new URL(base).origin;
  const exchanged = await fetch(`${origin}/__agentcanvas/pi/auth/exchange`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ secret: host.controlPlaneAuth.issueEntry(origin) }),
  });
  assert.equal(exchanged.status, 200, "fixture must exchange a host-issued one-time entry");
  const cookie = exchanged.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "exchange must return a session cookie");
  const { csrfToken } = await exchanged.json() as { csrfToken: string };
  assert.ok(csrfToken);
  const authFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin, "fixture credentials must never leave their host");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set("cookie", cookie);
    headers.set("x-raytonebot-csrf", csrfToken);
    return fetch(input, { ...init, headers });
  };
  if (developer) assert.equal((await authFetch(`${origin}/__agentcanvas/pi/auth/developer/grant`, { method: "POST" })).status, 200);
  return Object.assign(authFetch, { headers: { cookie, origin, "x-raytonebot-csrf": csrfToken } });
}
