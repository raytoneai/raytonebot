import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { buildClaudeArgs, hostMcpResponse } from "./cliHarness.ts";
import { normalizeClaudeTool } from "./cliStreams.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import { createWebTools, getPublicPage, htmlToText, WEB_TOOL_SPECS, type WebTools } from "./webAccess.ts";

type Json = Record<string, unknown>;

test("HTML becomes readable Markdown-like text without scripts, navigation or raw entities", () => {
  const text = htmlToText(`<html><head><title>Docs &amp; notes</title><style>p{}</style></head><body>
    <nav><a href="/home">Home</a></nav><h2>Install</h2><p>Run <b>npm&nbsp;ci</b> &#x2014; then <a href="/start?a=1&amp;b=2">start</a>.</p>
    <script>alert(1)</script><ul><li>one</li><li>two</li></ul></body></html>`, new URL("https://docs.example/guide"));
  assert.equal(text, "# Docs & notes\n\n## Install\n\nRun npm ci — then [start](https://docs.example/start?a=1&b=2).\n- one\n- two");
});

test("web_search formats Tavily results and reports a missing or rejected key as a tool error", async () => {
  const bodies: Json[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer tvly-key");
    return Response.json({ results: [{ title: "Raytone", url: "https://raytone.example", content: "An  AI\nassistant." }, { title: "no url" }] });
  }) as typeof fetch;
  const web = createWebTools({ env: { TAVILY_API_KEY: "tvly-key" }, fetcher });
  assert.deepEqual(await web.run("web_search", { query: " raytone ", max_results: 50, time_range: "week" }),
    { text: "1. Raytone\n   https://raytone.example\n   An AI assistant.", isError: false });
  assert.deepEqual(bodies[0], { query: "raytone", max_results: 10, search_depth: "basic", time_range: "week" });

  const missing = await createWebTools({ env: {} }).run("web_search", { query: "x" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /TAVILY_API_KEY/);
  const rejected = await createWebTools({ env: { TAVILY_API_KEY: "bad" }, fetcher: (async () => new Response("", { status: 401 })) as typeof fetch }).run("web_search", { query: "x" });
  assert.deepEqual(rejected, { text: "The search service rejected TAVILY_API_KEY.", isError: true });
});

test("web_fetch pages long text from one download and falls back to extraction for script-rendered pages", async () => {
  let downloads = 0;
  const long = "a".repeat(25_000);
  const web = createWebTools({ env: {}, getPage: async (url) => { downloads++; return { url: url.href, text: long, html: false }; } });
  const first = await web.run("web_fetch", { url: "https://long.example/#part" });
  assert.match(first.text, /\[Characters 0–20000 of 25000\. Call web_fetch with offset=20000 to continue\.\]$/);
  const second = await web.run("web_fetch", { url: "https://long.example/", offset: 20_000 });
  assert.equal(second.text, `${"a".repeat(5_000)}\n\n[Characters 20000–25000 of 25000.]`);
  assert.equal(downloads, 1);
  assert.equal((await web.run("web_fetch", { url: "https://long.example/", offset: 30_000 })).isError, true);

  const rendered = createWebTools({ env: { TAVILY_API_KEY: "k" },
    getPage: async (url) => ({ url: url.href, text: "Loading…", html: true }),
    fetcher: (async () => Response.json({ results: [{ raw_content: "# Rendered app\n\nReal content." }] })) as typeof fetch });
  assert.deepEqual(await rendered.run("web_fetch", { url: "https://app.example/" }), { text: "# Rendered app\n\nReal content.", isError: false });
  for (const url of ["file:///etc/passwd", "https://user:pw@example.com/", "not a url"]) {
    assert.equal((await web.run("web_fetch", { url })).isError, true, url);
  }
});

test("page reads refuse loopback and private targets, by literal and by name", async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end("internal"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  try {
    const signal = new AbortController().signal;
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, "http://169.254.169.254/latest/", "http://[::1]/", "http://10.0.0.1/"]) {
      await assert.rejects(getPublicPage(new URL(url), signal), /Private and local addresses/, url);
    }
    // The development allowance covers only proxy fake-IPs, never loopback.
    await assert.rejects(getPublicPage(new URL(`http://localhost:${port}/`), signal, { proxyFakeIp: true }), /Private and local addresses/);
    assert.equal(hits, 0);
  } finally { server.close(); }
});

test("Claude gets the web tools through its in-process MCP channel instead of its own Web* tools", async () => {
  const web: WebTools = { async run(name, args) { return { text: `${name}:${JSON.stringify(args)}`, isError: false }; } };
  const args = buildClaudeArgs({ permissionMode: "request", disallowedTools: ["Edit"], webTools: web });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { raytone: { type: "sdk", name: "raytone" } } });
  assert.deepEqual(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 4), ["Edit", "WebSearch", "WebFetch"]);
  assert.equal(buildClaudeArgs({ permissionMode: "request" }).includes("--mcp-config"), false);

  const signal = new AbortController().signal;
  assert.equal(((await hostMcpResponse({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, web, signal)).result as Json).protocolVersion, "2025-06-18");
  assert.deepEqual(((await hostMcpResponse({ jsonrpc: "2.0", id: 2, method: "tools/list" }, web, signal)).result as Json).tools, WEB_TOOL_SPECS);
  assert.deepEqual(await hostMcpResponse({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: "q" } } }, web, signal),
    { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "web_search:{\"query\":\"q\"}" }], isError: false } });
  assert.deepEqual(await hostMcpResponse({ jsonrpc: "2.0", method: "notifications/initialized" }, web, signal), { jsonrpc: "2.0", id: 0, result: {} });
  assert.ok((await hostMcpResponse({ jsonrpc: "2.0", id: 4, method: "resources/list" }, web, signal)).error);
  assert.deepEqual(normalizeClaudeTool("mcp__raytone__web_fetch", { url: "u" }), { name: "web_fetch", args: { url: "u" } });
});

test("Codex offers the web tools as dynamic tools on a new thread and answers their calls", async () => {
  const sent: Json[] = [], events: Json[] = [];
  const web: WebTools = { async run(name) { return name === "web_search" ? { text: "results", isError: false } : { text: "blocked", isError: true }; } };
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "search", signal: new AbortController().signal, webTools: web,
    emit: (event) => events.push(event as Json), onSessionId() {}, onPermission: async () => assert.fail("web tools need no grant") });
  const push = (line: Json) => protocol.push(line, (value) => sent.push(value));
  push({ id: "initialize", result: {} });
  const params = sent[1].params as Json;
  assert.deepEqual((params.dynamicTools as Json[]).map((tool) => [tool.type, tool.name]), [["function", "web_search"], ["function", "web_fetch"]]);
  assert.equal((params.config as Json).web_search, "disabled");
  push({ id: "thread", result: { thread: { id: "t" } } });
  push({ id: 7, method: "item/tool/call", params: { threadId: "t", turnId: "u", callId: "c", namespace: null, tool: "web_search", arguments: { query: "q" } } });
  push({ id: 8, method: "item/tool/call", params: { threadId: "t", turnId: "u", callId: "d", namespace: null, tool: "web_fetch", arguments: { url: "x" } } });
  push({ id: 9, method: "item/tool/call", params: { threadId: "other", turnId: "u", callId: "e", namespace: null, tool: "web_search", arguments: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.find((value) => value.id === 7), { id: 7, result: { contentItems: [{ type: "inputText", text: "results" }], success: true } });
  assert.deepEqual(sent.find((value) => value.id === 8), { id: 8, result: { contentItems: [{ type: "inputText", text: "blocked" }], success: false } });
  assert.equal(((sent.find((value) => value.id === 9)?.result as Json).success), false);

  push({ method: "item/started", params: { threadId: "t", item: { type: "dynamicToolCall", id: "c", namespace: null, tool: "web_search", arguments: { query: "q" }, status: "inProgress", contentItems: null, success: null } } });
  push({ method: "item/completed", params: { threadId: "t", item: { type: "dynamicToolCall", id: "c", namespace: null, tool: "web_search", arguments: { query: "q" }, status: "completed", contentItems: [{ type: "inputText", text: "results" }], success: true } } });
  const start = events.find((event) => event.type === "tool_execution_start");
  const end = events.find((event) => event.type === "tool_execution_end");
  assert.equal(start?.toolName, "web_search");
  assert.deepEqual(start?.args, { query: "q" });
  assert.equal(end?.isError, false);

  const resumed: Json[] = [];
  createCodexAppServer({ cwd: "/workspace", prompt: "again", resumeId: "t", signal: new AbortController().signal, webTools: web,
    emit() {}, onSessionId() {}, onPermission: async () => true }).push({ id: "initialize", result: {} }, (value) => resumed.push(value));
  assert.equal("dynamicTools" in (resumed[1].params as Json), false, "resume keeps the thread's own tools");
});
