import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { clientHelloServerName, createModelGateway, isPublicAddress } from "./runtime/modelGateway.ts";
import { agentIsolationEnabled, requireAgentIsolation } from "./runtime/agentProcess.ts";

test("model leases fix the provider/model, keep upstream keys private, cap calls, and revoke", async () => {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const gateway = await createModelGateway({ port: 0, fetcher: (async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response("data: done\n\n", { headers: { "content-type": "text/event-stream", "set-cookie": "provider-private=secret" } });
  }) as typeof fetch });
  try {
    let limits = 0;
    const lease = gateway.issue({ baseUrl: "https://api.deepseek.com/v1", apiKey: "private-upstream-key", model: "deepseek-flash", protocol: "openai", maxRequests: 1, onLimit: () => limits++ });
    assert.notEqual(lease.apiKey, "private-upstream-key");
    const request = (path: string, body: unknown, key = lease.apiKey) => fetch(`${lease.baseUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await request("/responses", { model: "expensive-model" })).status, 403);
    assert.equal((await request("/files", { model: "deepseek-flash" })).status, 403);
    assert.equal((await request("/responses", { model: "deepseek-flash" }, "bad-token")).status, 401);
    const response = await request("/responses", { model: "deepseek-flash", input: "hello" });
    assert.equal(await response.text(), "data: done\n\n");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/responses");
    assert.equal(calls[0].headers.get("authorization"), "Bearer private-upstream-key");
    assert.equal((await request("/responses", { model: "deepseek-flash" })).status, 429);
    assert.equal((await request("/responses", { model: "deepseek-flash" })).status, 429);
    assert.equal(limits, 1);
    lease.revoke();
    assert.equal((await request("/responses", { model: "deepseek-flash" })).status, 401);
    assert.throws(() => gateway.issue({ baseUrl: "http://127.0.0.1", apiKey: "x", model: "x", protocol: "openai" }), /HTTPS/);
  } finally { await gateway.close(); }
});

test("Anthropic leases use the fixed endpoint and reject redirects and elapsed duration", async () => {
  const calls: { url: string; headers: Headers; redirect?: RequestRedirect }[] = [];
  const gateway = await createModelGateway({ port: 0, fetcher: (async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), redirect: init?.redirect });
    return new Response(null, { status: 302, headers: { location: "https://other.example/" } });
  }) as typeof fetch });
  try {
    const lease = gateway.issue({ baseUrl: "https://api.deepseek.com/anthropic", apiKey: "upstream", model: "deepseek-flash", protocol: "anthropic" });
    const response = await fetch(`${lease.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": lease.apiKey }, body: JSON.stringify({ model: "deepseek-flash" }) });
    assert.equal(response.status, 502);
    assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal(calls[0].headers.get("x-api-key"), "upstream");
    assert.equal(calls[0].redirect, "manual");
    const beta = await fetch(`${lease.baseUrl}/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": lease.apiKey }, body: JSON.stringify({ model: "deepseek-flash" }) });
    assert.equal(beta.status, 502);
    assert.equal(calls[1].url, "https://api.deepseek.com/anthropic/v1/messages?beta=true");
    const query = await fetch(`${lease.baseUrl}/v1/messages?url=https://other.example`, { method: "POST", headers: { "x-api-key": lease.apiKey }, body: JSON.stringify({ model: "deepseek-flash" }) });
    assert.equal(query.status, 403);
    const expired = gateway.issue({ baseUrl: "https://api.deepseek.com/v1", apiKey: "upstream", model: "deepseek-flash", protocol: "openai", maxDurationMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const timeout = await fetch(`${expired.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${expired.apiKey}` }, body: JSON.stringify({ model: "deepseek-flash" }) });
    assert.equal(timeout.status, 429);
    assert.equal(calls.length, 2);
  } finally { await gateway.close(); }
});

test("package proxy excludes private addresses and sandbox execution has no unconfigured fallback", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.1.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["104.16.24.34", "2606:4700::6810:1822"]) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(agentIsolationEnabled({ RAYTONEBOT_SANDBOX: "1" }), true);
  assert.throws(() => requireAgentIsolation({ RAYTONEBOT_SANDBOX: "1" }), /not configured/);
});

test("package tunnels inspect the real TLS ClientHello hostname before connecting upstream", async () => {
  const server = createServer();
  const received = new Promise<Buffer>((resolve) => server.once("connection", (socket) => {
    socket.once("data", (data) => { resolve(data); socket.destroy(); });
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = tlsConnect({ host: "127.0.0.1", port: (server.address() as import("node:net").AddressInfo).port, servername: "registry.npmjs.org" });
  client.on("error", () => {});
  try {
    const hello = await received;
    assert.equal(clientHelloServerName(hello), "registry.npmjs.org");
    assert.equal(clientHelloServerName(Buffer.from("GET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n")), undefined);
    assert.equal(clientHelloServerName(hello.subarray(0, 20)), undefined);
  } finally { client.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("revoking a lease while a client uploads its body prevents any upstream call", async () => {
  let calls = 0;
  const gateway = await createModelGateway({ port: 0, fetcher: (async () => { calls++; return new Response("unexpected"); }) as typeof fetch });
  try {
    const lease = gateway.issue({ baseUrl: "https://api.deepseek.com/v1", apiKey: "private", model: "deepseek-flash", protocol: "openai" });
    const body = JSON.stringify({ model: "deepseek-flash" });
    const req = httpRequest(`${lease.baseUrl}/responses`, { method: "POST", headers: { Expect: "100-continue", authorization: `Bearer ${lease.apiKey}`, "content-length": Buffer.byteLength(body) } });
    const response = once(req, "response");
    req.flushHeaders();
    await once(req, "continue"); // The server has received headers and is now waiting for the body.
    lease.revoke();
    req.end(body);
    const [res] = await response;
    res.resume();
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 0);
  } finally { await gateway.close(); }
});

test("DeepSeek UI thinking levels reach every wire protocol and leave other providers untouched", async () => {
  const calls: Record<string, any>[] = [];
  const gateway = await createModelGateway({ port: 0, fetcher: (async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  try {
    for (const level of ['low', 'medium', 'high'] as const) {
      for (const path of ['/chat/completions', '/responses', '/messages']) {
        const lease = gateway.issue({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'private',
          protocol: path === '/messages' ? 'anthropic' : 'openai', thinkingLevel: level });
        const response = await fetch(`${lease.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${lease.apiKey}` },
          body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, reasoning: { effort: 'high', summary: 'none' },
            reasoning_effort: 'high', output_config: { effort: 'high', format: { type: 'text' } } }) });
        assert.equal(response.status, 200);
        const body = calls.at(-1)!;
        const effort = level === 'low' ? 'low' : level === 'high' ? 'max' : 'high';
        if (path === '/responses') { assert.equal(body.reasoning.effort, effort); assert.equal(body.reasoning.summary, 'none'); assert.equal(body.thinking, undefined); }
        else { assert.equal(body.thinking.type, 'enabled');
          if (path === '/messages') { assert.equal(body.output_config.effort, effort); assert.deepEqual(body.output_config.format, { type: 'text' }); }
          else assert.equal(body.reasoning_effort, effort);
        }
        lease.revoke();
      }
    }
    for (const baseUrl of ['https://other.example', 'https://api.deepseek.com.other.example']) {
      const lease = gateway.issue({ baseUrl, model: 'deepseek-flash', apiKey: 'private', protocol: 'openai', thinkingLevel: 'low' });
      const body = { model: 'deepseek-flash', reasoning: { effort: 'high' } };
      await fetch(`${lease.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${lease.apiKey}` }, body: JSON.stringify(body) });
      assert.deepEqual(calls.at(-1), body); lease.revoke();
    }
  } finally { await gateway.close(); }
});

test("Pi retains DeepSeek thinking capabilities behind its loopback model lease", async () => {
  const { registerEditorProvider } = await import('./piHost.ts');
  let registered: any;
  const runtime = { unregisterProvider() {}, registerProvider(_id: string, definition: unknown) { registered = definition; } };
  const definition = { id: 'deepseek', name: 'DeepSeek', baseUrl: 'http://127.0.0.1:9999/model', protocol: 'openai-compatible' as const,
    models: ['deepseek-flash', 'other-model'], authMode: 'required' as const };
  registerEditorProvider(runtime as any, definition, 'deepseek', 'deepseek-flash', 'https://api.deepseek.com/v1');
  assert.equal(registered.models[0].reasoning, true);
  assert.equal(registered.models[0].compat.thinkingFormat, 'deepseek');
  assert.equal(registered.models[0].compat.supportsDeveloperRole, false);
  assert.equal(registered.models[0].compat.maxTokensField, 'max_tokens');
  assert.equal(registered.models[0].compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(registered.models[1].reasoning, false);
  registerEditorProvider(runtime as any, definition, 'deepseek', 'deepseek-flash');
  assert.equal(registered.models[0].reasoning, false);
});
