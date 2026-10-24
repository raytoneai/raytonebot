import assert from "node:assert/strict";
import { test } from "node:test";

import { modelsUrl, probeProvider } from "./providerProbe.ts";

test("models URL: path joins, plain HTTP only on loopback", () => {
  assert.equal(modelsUrl("https://api.deepseek.com/v1/").href, "https://api.deepseek.com/v1/models");
  assert.equal(modelsUrl("http://127.0.0.1:11434/v1").href, "http://127.0.0.1:11434/v1/models");
  assert.throws(() => modelsUrl("http://example.com/v1"));
});

test("probe: models, auth header per protocol, HTTP errors", async () => {
  let seen: Headers | undefined;
  const ok = (async (_url: URL, init?: RequestInit) => {
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }));
  }) as typeof fetch;
  const result = await probeProvider({ baseUrl: "https://api.deepseek.com/v1", protocol: "openai-compatible" }, "k", ok);
  assert.deepEqual(result.models, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(result.ok, true);
  assert.equal(seen?.get("authorization"), "Bearer k");

  await probeProvider({ baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic" }, "a", ok);
  assert.equal(seen?.get("x-api-key"), "a");

  const denied = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  const failed = await probeProvider({ baseUrl: "https://x.example/v1", protocol: "openai-compatible" }, "bad", denied);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 401);
});

test("probe rejects malformed model responses instead of reporting a successful connection", async () => {
  for (const body of ["<html>login</html>", "null", "{}", '{"error":"invalid key"}', '{"data":[{"id":42}]}']) {
    const result = await probeProvider({ baseUrl: "https://model.example/v1", protocol: "openai-compatible" }, "key",
      (async () => new Response(body)) as typeof fetch);
    assert.equal(result.ok, false, body);
    assert.deepEqual(result.models, []);
  }
});

test("probe normalizes and deduplicates model IDs to the settings storage limits", async () => {
  const ids = [" model-a ", "model-a", "", "  ", "bad\nmodel", "x".repeat(257), "model-b"];
  const result = await probeProvider({ baseUrl: "https://model.example/v1", protocol: "openai-compatible" }, undefined,
    (async () => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }))) as typeof fetch);
  assert.deepEqual(result.models, ["model-a", "model-b"]);
  const empty = await probeProvider({ baseUrl: "https://model.example/v1", protocol: "openai-compatible" }, undefined,
    (async () => new Response('{"data":[]}')) as typeof fetch);
  assert.equal(empty.ok, true);
});

test("probe disables credential-bearing redirects and accepts IPv6 loopback", async () => {
  assert.equal(modelsUrl("http://[::1]:11434/v1").href, "http://[::1]:11434/v1/models");
  for (const url of ["https://user:pass@model.example/v1", "https://model.example/v1?key=secret", "https://model.example/v1#secret"]) {
    assert.throws(() => modelsUrl(url));
  }
  const result = await probeProvider({ baseUrl: "https://model.example/v1", protocol: "anthropic" }, "secret",
    (async (_url, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://other.example" } });
    }) as typeof fetch);
  assert.equal(result.ok, false);
  assert.equal(result.status, 302);
});
