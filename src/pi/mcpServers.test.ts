import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PiApprovalGate } from "./approvalGate.ts";
import { ApprovalMemory } from "./approvalMemory.ts";
import { buildClaudeArgs, sdkMcpResponse } from "./cliHarness.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import { createMcpService, mcpResultText } from "./mcpServers.ts";
import { classifyToolCall } from "./permissionPolicy.ts";

type Json = Record<string, unknown>;

/** A Streamable HTTP MCP server: sessions, bearer auth, JSON or SSE answers, forgettable sessions. */
async function fakeMcp(options: { token?: string; sse?: boolean } = {}) {
  const sessions = new Set<string>();
  const calls: { name: string; arguments: unknown; session?: string }[] = [];
  const seen: { method: string; authorization?: string; session?: string; version?: string }[] = [];
  let next = 0;
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body) as Json;
    const session = req.headers["mcp-session-id"] as string | undefined;
    seen.push({ method: String(message.method), authorization: req.headers.authorization, session, version: req.headers["mcp-protocol-version"] as string | undefined });
    if (options.token && req.headers.authorization !== `Bearer ${options.token}`) { res.statusCode = 401; res.end(); return; }
    if (message.method !== "initialize" && (!session || !sessions.has(session))) { res.statusCode = 404; res.end(); return; }
    if (message.id === undefined) { res.statusCode = 202; res.end(); return; }
    const answer = (result: unknown) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      if (options.sse) {
        res.setHeader("content-type", "text/event-stream");
        // A progress notification first: the client must skip it and wait for its own answer.
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\nevent: message\ndata: ${text}\n\n`);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(text);
      }
    };
    const params = (message.params ?? {}) as Json;
    if (message.method === "initialize") {
      const id = `s${++next}`;
      sessions.add(id);
      res.setHeader("mcp-session-id", id);
      answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    } else if (message.method === "tools/list") {
      answer(params.cursor ? { tools: [{ name: "create.issue", description: "Open an issue.", inputSchema: { $schema: "x", type: "object", properties: { title: { type: "string" } }, required: ["title"] } }] }
        : { tools: [{ name: "search", title: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }, { name: "search" }, { name: "x".repeat(70) }], nextCursor: "2" });
    } else if (message.method === "tools/call") {
      calls.push({ name: String(params.name), arguments: params.arguments, session });
      answer(params.name === "search" ? { content: [{ type: "text", text: "found 3" }, { type: "image", mimeType: "image/png", data: "AAAA" }] }
        : { content: [{ type: "text", text: "no permission" }], isError: true });
    } else res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  return { url, calls, seen, sessions, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("a saved server is listed at once, keeps its token on the server only, and its tools are callable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-mcp-"));
  const remote = await fakeMcp({ token: "secret-token", sse: true });
  try {
    const mcp = createMcpService({ dataDir });
    const saved = await mcp.save(undefined, { name: "GitHub Issues", url: remote.url, token: " secret-token " });
    assert.equal(saved.id, "github-issues");
    assert.equal(saved.status, "ready");
    assert.equal(saved.hasToken, true);
    assert.deepEqual(saved.tools, ["search", "create_issue"], "paged, deduplicated, too-long names skipped, unsafe characters replaced");
    assert.doesNotMatch(JSON.stringify(mcp.list()), /secret-token/);
    assert.equal(statSync(join(dataDir, "mcp.json")).mode & 0o777, 0o600);
    assert.equal(remote.seen[0].authorization, "Bearer secret-token");
    assert.equal(remote.seen.at(-1)?.version, "2025-06-18");

    const toolkit = mcp.toolkit()!;
    assert.deepEqual(toolkit.specs.map((spec) => spec.name), ["mcp__github-issues__search", "mcp__github-issues__create_issue"]);
    assert.equal(toolkit.specs[0].description, "[GitHub Issues] Search");
    assert.equal("$schema" in toolkit.specs[1].inputSchema, false);
    assert.deepEqual(toolkit.servers.map((server) => [server.id, server.tools.map((tool) => tool.name)]), [["github-issues", ["search", "create_issue"]]]);

    assert.deepEqual(await toolkit.run("mcp__github-issues__search", { q: "bug" }), { text: "found 3\n\n[image: image/png, not shown]", isError: false });
    assert.deepEqual(await toolkit.run("mcp__github-issues__create_issue", { title: "t" }), { text: "no permission", isError: true });
    assert.deepEqual(remote.calls.map((call) => call.name), ["search", "create.issue"], "the server gets its own tool name back");
    assert.equal((await toolkit.run("mcp__github-issues__nope", {})).isError, true);

    // The server restarted and forgot the session: one new session, then the call goes through.
    remote.sessions.clear();
    assert.equal((await toolkit.run("mcp__github-issues__search", { q: "again" })).isError, false);

    // A restart reads the saved tools without asking the server.
    const before = remote.seen.length;
    assert.deepEqual(createMcpService({ dataDir }).list()[0].tools, ["search", "create_issue"]);
    assert.equal(remote.seen.length, before);

    // Switching off removes its tools; a run that kept the old toolkit gets a clear error.
    await mcp.save(saved.id, { enabled: false });
    assert.equal(mcp.toolkit(), undefined);
    assert.match((await toolkit.run("mcp__github-issues__search", {})).text, /switched off.*removed/);
  } finally { await remote.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("MCP assignment filters both engine tool catalogs and rejects tools outside the offered servers", async () => {
  const docsRemote = await fakeMcp(), issuesRemote = await fakeMcp();
  try {
    const mcp = createMcpService();
    const docs = await mcp.save(undefined, { name: "Docs", url: docsRemote.url });
    const issues = await mcp.save(undefined, { name: "Issues", url: issuesRemote.url });
    assert.equal(mcp.toolkit([]), undefined, "an explicit empty assignment offers no remote tools");
    assert.equal(mcp.toolkit(["missing"]), undefined);
    assert.deepEqual(mcp.toolkit()!.servers.map(server => server.id), [docs.id, issues.id], "omitted assignments preserve the legacy catalog");

    const toolkit = mcp.toolkit([docs.id])!;
    assert.deepEqual(toolkit.specs.map(spec => spec.name), ["mcp__docs__search", "mcp__docs__create_issue"]);
    assert.deepEqual(toolkit.servers.map(server => [server.id, server.tools.map(tool => tool.name)]), [["docs", ["search", "create_issue"]]],
      "Claude SDK servers receive the same assignment filtering as Pi/Codex specs");
    const denied = await toolkit.run("mcp__issues__search", { q: "not assigned" });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /Unknown MCP tool/);
    assert.equal(issuesRemote.calls.length, 0, "a forged unoffered tool name cannot reach its remote server");
    assert.equal((await toolkit.run("mcp__docs__search", { q: "assigned" })).isError, false);
    assert.deepEqual(docsRemote.calls.map(call => [call.name, call.arguments]), [["search", { q: "assigned" }]]);

    const liveFiltered = mcp.toolkit([docs.id, issues.id], id => id === docs.id)!;
    assert.deepEqual(liveFiltered.servers.map(server => server.id), [docs.id], "the live check also applies when building a new catalog");
  } finally { await Promise.all([docsRemote.close(), issuesRemote.close()]); }
});

test("a stale MCP toolkit rechecks live Bot assignment before dispatch without disabling the shared server", async () => {
  const docsRemote = await fakeMcp(), issuesRemote = await fakeMcp();
  try {
    const mcp = createMcpService();
    const docs = await mcp.save(undefined, { name: "Docs", url: docsRemote.url });
    const issues = await mcp.save(undefined, { name: "Issues", url: issuesRemote.url });
    const assigned = new Set([docs.id, issues.id]);
    const allowed = (id: string) => assigned.has(id);
    const toolkit = mcp.toolkit([docs.id, issues.id], allowed)!;
    assert.equal((await toolkit.run("mcp__docs__search", { q: "before revocation" })).isError, false);
    const callsBefore = docsRemote.calls.length;

    assigned.delete(docs.id); // The model still holds the old tool catalog during this run.
    assert.equal(mcp.list().find(server => server.id === docs.id)?.enabled, true);
    const denied = await toolkit.run("mcp__docs__search", { q: "after revocation" });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /no longer assigned/);
    assert.equal(docsRemote.calls.length, callsBefore, "revocation blocks the outgoing connector call");
    assert.equal((await toolkit.run("mcp__issues__search", { q: "still assigned" })).isError, false);
    assert.equal(issuesRemote.calls.length, 1);
    assert.deepEqual(mcp.toolkit([docs.id, issues.id], allowed)!.servers.map(server => server.id), [issues.id]);
    assigned.clear();
    assert.equal(mcp.toolkit([docs.id, issues.id], allowed), undefined);
    assert.equal((await toolkit.run("mcp__issues__search", {})).isError, true);
    assert.equal(issuesRemote.calls.length, 1);
  } finally { await Promise.all([docsRemote.close(), issuesRemote.close()]); }
});

test("bad addresses are refused, a rejected token is shown on the server, and a new name never takes a used id", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-mcp-errors-"));
  const remote = await fakeMcp({ token: "right" });
  try {
    const mcp = createMcpService({ dataDir });
    for (const [url, pattern] of [["not a url", /full URL/], ["ftp://x/mcp", /https/], ["http://example.com/mcp", /https:\/\//], ["https://u:p@example.com/mcp", /token field/]] as const) {
      await assert.rejects(mcp.save(undefined, { name: "x", url }), pattern);
    }
    await assert.rejects(mcp.save(undefined, { name: " ", url: remote.url }), /name/);
    const wrong = await mcp.save(undefined, { name: "Raytone", url: remote.url, token: "wrong" });
    assert.equal(wrong.id, "raytone-2", "the host's own server name is reserved");
    assert.equal(wrong.status, "error");
    assert.match(wrong.error!, /rejected the token/);
    assert.equal(mcp.toolkit(), undefined, "a failing server offers no tools");

    const fixed = await mcp.save(wrong.id, { token: "right" });
    assert.equal(fixed.status, "ready");
    const cleared = await mcp.save(wrong.id, { clearToken: true });
    assert.equal(cleared.hasToken, false);
    assert.equal(cleared.status, "error");

    const chinese = await mcp.save(undefined, { name: "飞书文档", url: remote.url, enabled: false });
    assert.equal(chinese.id, "mcp");
    assert.equal(chinese.status, "off");
    assert.equal(remote.seen.filter((entry) => entry.method === "initialize").length, 3, "a server saved switched off is not contacted");
    mcp.remove(chinese.id);
    assert.throws(() => mcp.remove(chinese.id), /not found/);
    assert.doesNotMatch(readFileSync(join(dataDir, "mcp.json"), "utf8"), /飞书文档/);
  } finally { await remote.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("MCP calls are connector calls: they ask under request and auto until always-allowed", async () => {
  const policy = { cwd: "/workspace", protectedPaths: [] };
  assert.equal(classifyToolCall("mcp__github__search", {}, policy), "connector");
  assert.equal(classifyToolCall("mcp__raytone__web_search", {}, policy), "read", "the host's own web tools stay reads");
  const memory = new ApprovalMemory();
  const gate = (mode: "request" | "auto" | "allow-all") => {
    const value = new PiApprovalGate(policy, memory);
    value.setMode(mode);
    value.setAgent("assistant");
    return value;
  };
  assert.equal(gate("request").requiresApproval("mcp__github__search", {}), true);
  assert.equal(gate("auto").requiresApproval("mcp__github__search", {}), true);
  assert.equal(gate("allow-all").requiresApproval("mcp__github__search", {}), false);
  memory.add("assistant", "mcp__github__search");
  assert.equal(gate("auto").requiresApproval("mcp__github__search", {}), false);
  assert.equal(gate("auto").requiresApproval("mcp__github__create_issue", {}), true);
});

test("Claude gets each server as an SDK server; Codex offers the tools and gates every call", async () => {
  const runs: string[] = [];
  const toolkit = { specs: [{ name: "mcp__docs__search", description: "[Docs] Search", inputSchema: { type: "object" } }],
    servers: [{ id: "docs", tools: [{ name: "search", description: "[Docs] Search", inputSchema: { type: "object" } }] }],
    async run(name: string) { runs.push(name); return { text: "ok", isError: false }; } };
  const args = buildClaudeArgs({ permissionMode: "request", mcpTools: toolkit });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { docs: { type: "sdk", name: "docs" } } });
  const signal = new AbortController().signal;
  const server = { name: "docs", tools: toolkit.servers[0].tools, run: (name: string) => toolkit.run(`mcp__docs__${name}`) };
  assert.deepEqual(((await sdkMcpResponse({ jsonrpc: "2.0", id: 1, method: "tools/list" }, server, signal)).result as Json).tools, toolkit.servers[0].tools);
  await sdkMcpResponse({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: {} } }, server, signal);
  assert.deepEqual(runs, ["mcp__docs__search"]);

  const sent: Json[] = [];
  const asked: string[] = [];
  let allow: true | string = "Tool execution was denied by the user.";
  const protocol = createCodexAppServer({ cwd: "/workspace", prompt: "find", signal, mcpTools: toolkit, emit() {}, onSessionId() {},
    async onPermission(request) { asked.push(request.tool.name); return allow; } });
  const push = (line: Json) => protocol.push(line, (value) => sent.push(value));
  push({ id: "initialize", result: {} });
  // Codex reserves `mcp__*` (a thread offering one fails to start); it sees `mcp_docs__search`.
  assert.deepEqual(((sent[1].params as Json).dynamicTools as Json[]).map((tool) => tool.name), ["mcp_docs__search"]);
  assert.ok(((sent[1].params as Json).dynamicTools as Json[]).every((tool) => !String(tool.name).startsWith("mcp__")));
  push({ id: "thread", result: { thread: { id: "t" } } });
  const call = (id: number) => push({ id, method: "item/tool/call", params: { threadId: "t", callId: `c${id}`, tool: "mcp_docs__search", arguments: { q: "x" } } });
  call(10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.at(-1), { id: 10, result: { contentItems: [{ type: "inputText", text: "Tool execution was denied by the user." }], success: false } });
  assert.deepEqual(runs, ["mcp__docs__search"], "a declined call never reaches the server");
  allow = true;
  call(11);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.at(-1), { id: 11, result: { contentItems: [{ type: "inputText", text: "ok" }], success: true } });
  assert.deepEqual(asked, ["mcp__docs__search", "mcp__docs__search"]);
});

test("tool results keep text, name what they cannot show, and are cut when huge", () => {
  assert.equal(mcpResultText({ content: [] }), "(The tool returned no content.)");
  assert.equal(mcpResultText({ content: [], structuredContent: { a: 1 } }), "{\n  \"a\": 1\n}");
  assert.equal(mcpResultText({ content: [{ type: "resource", resource: { uri: "file:///a", text: "body" } }, { type: "resource_link", name: "doc", uri: "https://x" }] }), "body\n\n[link: doc https://x]");
  assert.match(mcpResultText({ content: [{ type: "text", text: "x".repeat(60_000) }] }), /Cut at 50000 of 60000 characters/);
});

test("Pi gets the MCP tools with their own schemas; a failed call is a tool error", async () => {
  const { mcpPiTools } = await import("./mcpTool.ts");
  const toolkit = { specs: [{ name: "mcp__docs__search", description: "[Docs] Search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    servers: [], async run(_name: string, args: unknown) { return (args as Json).q === "x" ? { text: "hit", isError: false } : { text: "no such page", isError: true }; } };
  const [tool] = mcpPiTools(toolkit);
  assert.equal(tool.name, "mcp__docs__search");
  assert.deepEqual(tool.parameters, toolkit.specs[0].inputSchema);
  const run = (q: string) => tool.execute("call", { q } as never, undefined, undefined as never, undefined as never);
  assert.deepEqual((await run("x")).content, [{ type: "text", text: "hit" }]);
  await assert.rejects(run("y"), /no such page/);
});
