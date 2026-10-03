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
