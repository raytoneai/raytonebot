import assert from "node:assert/strict";
import { test } from "node:test";

import { browserLogin, sendBrowserInputs } from "../piClient.ts";
import { browserAccountScope, classifyBrowserCall } from "./browserPolicy.ts";
import { BROWSER_TOOL_SPECS, browserAccountHint, browserAccountNote } from "./browserTools.ts";

const idle = { controller: "agent" as const, clearing: false };

test("turn account hints contain fresh dynamic scopes in under 512 bytes", () => {
  const origins = new Set([
    "https://accounts.google.com", "https://www.google.com.hk", "https://www.google.co.jp",
    "https://github.com", "https://www.reddit.com", "https://x.com", "https://account.apple.com",
    "https://alice:secret@accounts.google.com/?cookie=session#identity",
  ]);
  const hint = browserAccountHint(origins, idle);
  assert.ok(Buffer.byteLength(hint) < 512, hint);
  assert.match(hint, /"unverified":\["apple.com","github.com","google.com","reddit.com","x.com"\]/);
  assert.match(hint, /"controller":"agent","clearing":false/);
  assert.match(hint, /supersedes older records/);
  assert.doesNotMatch(hint, /alice|secret|session|identity|accounts.google.com|cookie/);
  assert.ok(Buffer.byteLength(hint) < Buffer.byteLength(browserAccountNote(origins, idle)) / 4);
});

test("empty and clearing hints supersede previous records without caching", () => {
  const origins = new Set(["https://github.com"]);
  assert.match(browserAccountHint(origins, idle), /github.com/);
  origins.clear();
  const hint = browserAccountHint(origins, { controller: "user", clearing: true });
  assert.match(hint, /"controller":"user","clearing":true,"unverified":\[\]/);
  assert.match(hint, /supersedes older records/);
  assert.doesNotMatch(hint, /github.com/);
  assert.ok(Buffer.byteLength(hint) < 200);
});

test("many account scopes stay bounded and expose the complete-list tool", () => {
  const origins = new Set(Array.from({ length: 200 }, (_, index) => `https://site-${index}-${"a".repeat(50)}.com`));
  const hint = browserAccountHint(origins, idle);
  assert.ok(Buffer.byteLength(hint) < 512, hint);
  assert.match(hint, /"omitted":\d+/);
  assert.match(hint, /browser_accounts for full list/);
  const full = browserAccountNote(origins, idle);
  assert.match(full, /site-199-/);
  assert.doesNotMatch(full, /"omitted"/);
  const tool = BROWSER_TOOL_SPECS.find((spec) => spec.name === "browser_accounts")!;
  assert.match(tool.description, /unverified/);
  assert.match(tool.description, /user-requested private content/);
  assert.match(tool.description, /existing approvals still apply/);
  assert.match(tool.description, /Never enter passwords, one-time codes or payment details/);
  assert.match(tool.description, /request takeover/);
});

test("official Google country domains share account metadata and conservative approvals", () => {
  const loggedIn = new Set(["https://accounts.google.com"]);
  for (const origin of ["https://www.google.com.hk", "https://www.google.co.jp", "https://google.co.uk"]) {
    assert.equal(browserAccountScope(origin), "google.com");
    const call = classifyBrowserCall("browser_click", { ref: "e1" }, {
      origin, loggedIn, elements: { e1: { role: "link", name: "Read more" } },
    });
    assert.deepEqual(call, { kind: "connector", key: `browser_click@${origin}` });
    assert.match(browserAccountNote(new Set([origin]), idle), /"scope":"google.com"/);
  }
});

test("Google lookalikes and private suffix tenants never join its account scope", () => {
  for (const origin of [
    "https://google.github.io", "https://google.com.evil.example", "https://google.com.hk.evil.example",
    "https://google.notreal", "https://notgoogle.com", "https://google-login.com",
  ]) {
    assert.notEqual(browserAccountScope(origin), "google.com", origin);
    assert.equal(classifyBrowserCall("browser_click", { ref: "e1" }, {
      origin, loggedIn: new Set(["https://accounts.google.com"]), elements: { e1: { role: "link", name: "Read more" } },
    })?.kind, "mutating", origin);
  }
});

test("login and input clients accept injected fetch without changing request behavior", async () => {
  const requests: { input: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({ controller: "user", running: true });
  };
  const state = await browserLogin("other", "https://example.com/login", fetcher);
  assert.equal(state.controller, "user");
  assert.equal(requests[0].input, "/__agentcanvas/pi/browser/control");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { action: "login", site: "other", url: "https://example.com/login" });
  const controller = new AbortController();
  await sendBrowserInputs([{ kind: "key", type: "down", key: "Tab" }], controller.signal, fetcher);
  assert.equal(requests[1].input, "/__agentcanvas/pi/browser/input");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { inputs: [{ kind: "key", type: "down", key: "Tab" }] });
  assert.equal(requests[1].init?.signal?.aborted, false);
  controller.abort();
  assert.equal(requests[1].init?.signal?.aborted, true);
  await sendBrowserInputs([{ kind: "text", text: "bounded" }], new AbortController().signal, fetcher, { pageId: "tab-id", controlEpoch: 123 });
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { inputs: [{ kind: "text", text: "bounded" }], pageId: "tab-id", controlEpoch: 123 });
});
