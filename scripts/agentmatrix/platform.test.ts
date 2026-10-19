import assert from "node:assert/strict";
import { test } from "node:test";

import { CHUNK_BYTES, lastAgentText, listAll, networkPolicy, previewOrigin, runtimeConfig } from "./platform.mjs";

test("the environment spec opens exactly the app port and denies everything else", () => {
  const policy = networkPolicy(5188);
  assert.equal(policy.outbound.default, "deny");
  assert.deepEqual(policy.outbound.allow, [
    { type: "domain", domain: "api.deepseek.com" },
    { type: "domain", domain: "registry.npmjs.org" },
  ]);
  assert.equal(policy.public_access.default, "deny");
  assert.deepEqual(policy.public_access.allow, [{ type: "port", protocol: "http", port: 5188 }]);
});

test("a provider without allowlist support gets open egress instead of a false claim", () => {
  const policy = networkPolicy(5188, { outboundAllowlist: false });
  assert.deepEqual(policy.outbound, { default: "allow", allow: [] });
  assert.deepEqual(policy.public_access.allow, [{ type: "port", protocol: "http", port: 5188 }]);
});

test("container sandboxes nest the provider id under runtime_config.container", () => {
  assert.deepEqual(runtimeConfig({ runtime_kind: "container_sandbox", sandbox_provider_id: "sbp_1" }),
    { kind: "container", container: { sandbox_provider_id: "sbp_1" } });
  assert.deepEqual(runtimeConfig({ runtime_kind: "e2b_sandbox", sandbox_provider_id: "sbp_1" }),
    { sandbox_provider_id: "sbp_1" });
});

test("the archive is chunked below the 1 MiB workspace file cap", () => {
  assert.equal(CHUNK_BYTES, 1024 * 1024);
  assert.ok(CHUNK_BYTES <= 1024 * 1024);
});

test("listAll follows next_page until has_more is false", async () => {
  const pages = [
    { data: [1, 2], has_more: true, next_page: "p2" },
    { data: [3], has_more: false, next_page: null },
  ];
  const seen = [];
  const rows = await listAll(async (query) => {
    seen.push(query.cursor ?? null);
    return pages[seen.length - 1];
  });
  assert.deepEqual(rows, [1, 2, 3]);
  assert.deepEqual(seen, [null, "p2"]);
});

test("previewOrigin keeps the proxy origin and drops the signed open path", () => {
  const preview = {
    url: "https://prv-abc.preview.example/.ariadra/preview/open?token=v1.tok&redirect=%2F",
  };
  assert.equal(previewOrigin(preview), "https://prv-abc.preview.example");
});

test("lastAgentText returns the newest agent message, not an older one", () => {
  const events = [
    { type: "agent.message", payload: { content: [{ type: "text", text: "old" }] } },
    { type: "agent.tool_use", payload: { tool_name: "Bash" } },
    { type: "agent.message", payload: { content: [{ type: "text", text: "AM_INSTALLED" }] } },
  ];
  assert.equal(lastAgentText(events), "AM_INSTALLED");
  assert.equal(lastAgentText([]), "");
});
