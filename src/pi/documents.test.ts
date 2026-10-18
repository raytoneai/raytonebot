import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";
import { createWorkspaceDocument, readWorkspaceDocument, replaceWorkspaceDocument, searchWorkspaceDocuments } from "./workspaceFiles.ts";

test("document versions prevent lost edits; local search and attachment reads use the latest bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rtb-documents-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "work") }); ensureWorkspaceLayout(layout);
  const previousMask = process.umask(0o077);
  try {
    const first = await createWorkspaceDocument(layout, "shared", "Review.md", "# Original\nold keyword");
    const copy = await createWorkspaceDocument(layout, "shared", "Review.md", "second");
    assert.notEqual(first.path, copy.path, "save as never overwrites an earlier copy");
    const attempts = await Promise.allSettled([replaceWorkspaceDocument(layout, "shared", first.path, "new keyword alpha", first.version), replaceWorkspaceDocument(layout, "shared", first.path, "overwrite alpha", first.version)]);
    assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1);
    const updated = await readWorkspaceDocument(layout, "shared", first.path);
    assert.equal((await stat(join(layout.shared!, first.path))).mode & 0o777, 0o660, "edits stay readable to isolated agent groups under umask 077");
    // Path checks are asynchronous: either caller may acquire the save lease first.
    const winner = attempts.find(a => a.status === "fulfilled");
    assert.ok(winner?.status === "fulfilled");
    assert.equal(updated.content, winner.value.content); assert.notEqual(updated.version, first.version);
    const loser = attempts.find(a => a.status === "rejected");
    assert.ok(loser?.status === "rejected"); assert.match(String(loser.reason), /changed/);
    await assert.rejects(replaceWorkspaceDocument(layout, "shared", first.path, "stale", first.version), /changed/);
    assert.equal((await searchWorkspaceDocuments(layout, "shared", "", "alpha")).files[0].path, first.path);
    assert.equal((await searchWorkspaceDocuments(layout, "shared", "", "Review.md")).files.length, 1);
    await assert.rejects(readWorkspaceDocument(layout, "shared", "../secret.md"), /not allowed|outside|path/i);
    await writeFile(join(root, "secret.md"), "private");
    await symlink(join(root, "secret.md"), join(layout.shared!, "link.md"));
    await assert.rejects(readWorkspaceDocument(layout, "shared", "link.md"), /links/);
    await link(join(root, "secret.md"), join(layout.shared!, "hard.md"));
    await assert.rejects(replaceWorkspaceDocument(layout, "shared", "hard.md", "bad", first.version), /linked/);
    await assert.rejects(createWorkspaceDocument(layout, "shared", "page.html", "code"), /md/);
    await assert.rejects(createWorkspaceDocument(layout, "shared", "huge.md", "a".repeat(256 * 1024 + 1)), /256/);
    await mkdir(join(layout.shared!, ".hidden")); await writeFile(join(layout.shared!, ".hidden/private.md"), "alpha");
    assert.equal((await searchWorkspaceDocuments(layout, "shared", "", "alpha")).files.length, 1);
  } finally { process.umask(previousMask); await rm(root, { recursive: true, force: true }); }
});

test("document HTTP saves source metadata, conflicts preserve bytes, and a new conversation attaches the edited file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rtb-doc-http-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "work") }); ensureWorkspaceLayout(layout);
  const prompts: string[] = [], attachedContents: string[] = [];
  const factory: PiBridgeFactory = async () => ({ subscribe: () => () => {}, prompt: async p => { prompts.push(p); const match = p.match(/<attached_workspace_files>[\s\S]*?\n(\[[^\n]+\])\n<\/attached_workspace_files>/); if (match) for (const file of JSON.parse(match[1])) attachedContents.push(await readFile(file.path, "utf8")); }, abort: async () => {}, configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {}, dispose() {} });
  const host = createPiHttpHost({ cwd: layout.agents.assistant, dataDir: join(root, "data"), layout, bridgeFactory: factory, routineClock: false, browser: false });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const post = (path: string, value: unknown, method = "POST") => fetch(url + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  try {
    await host.controller.runPrompt({ conversationId: "source", prompt: "Create document" }, () => {});
    const saved = await post("/documents", { scope: "shared", name: "Guide.md", content: "original", conversationId: "source", artifactId: "published_test" });
    assert.equal(saved.status, 201); const doc = await saved.json();
    assert.equal(host.controller.getConversation("source")?.documents?.[0].path, doc.path);
    const edited = await post("/documents", { scope: "shared", path: doc.path, content: "updated alpha", version: doc.version }, "PUT");
    assert.equal(edited.status, 200);
    assert.equal((await post("/documents", { scope: "shared", path: doc.path, content: "bad", version: doc.version }, "PUT")).status, 409);
    const opened = await (await fetch(`${url}/documents?${new URLSearchParams({ scope: "shared", path: doc.path })}`)).json();
    assert.equal(opened.source.conversationId, "source"); assert.equal(opened.source.artifactId, "published_test"); assert.equal(typeof opened.source.title, "string");
    assert.equal(opened.content, "updated alpha");
    await host.controller.runPrompt({ conversationId: "next", prompt: "Read the latest", attachments: [{ scope: "shared", path: doc.path }] }, () => {});
    assert.match(prompts.at(-1)!, /attached_workspace_files/);
    assert.equal(attachedContents.at(-1), "updated alpha", "the next engine actually reads edited bytes at the supplied path");
    assert.equal(await readFile(join(layout.shared!, doc.path), "utf8"), "updated alpha");
    const submission = { artifactId: "quote.form.json", submissionId: "form_abc" };
    const request = { conversationId: "next", requestId: submission.submissionId, prompt: "Budget\nAmount: 12.5", artifactSubmission: submission };
    await host.controller.runPrompt(request, () => {});
    assert.deepEqual(host.controller.getConversation("next")?.turns?.at(-1)?.artifactSubmission, submission);
    const calls = prompts.length;
    await assert.rejects(host.controller.runPrompt(request, () => {}), /already.*submitted/);
    assert.equal(prompts.length, calls);
    await assert.rejects(host.controller.runPrompt({ ...request, requestId: "wrong" }, () => {}), /identity/);
    const found = await (await fetch(`${url}/files?scope=shared&query=alpha`)).json(); assert.equal(found.files.length, 1);
    const foreign = await fetch(`${url}/documents`, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: JSON.stringify({ scope: "shared", name: "bad.md", content: "no" }) });
    assert.equal(foreign.status, 403);
  } finally { host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
