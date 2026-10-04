import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPiHttpHost, type PiBridgeFactory } from "./piHost.ts";
import type { PiFileReference } from "./piClient.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";
import { MAX_UPLOAD_BYTES } from "./workspaceFiles.ts";

test("workspace HTTP upload → model file context → output download, with path and upload boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "rtb-files-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "workspace") });
  ensureWorkspaceLayout(layout);
  let modelPrompt = "";
  const bridgeFactory: PiBridgeFactory = async () => ({
    subscribe: () => () => undefined,
    async prompt(text) {
      modelPrompt = text;
      const files = JSON.parse(text.split("\n").at(-2)!) as { path: string }[];
      await writeFile(join(layout.agents.assistant, "result.bin"), await readFile(files[0].path));
    },
    abort: async () => undefined,
    dispose() {}, configure: async () => undefined,
    state: async () => ({ models: [], tools: [] }) as never,
    newSession: async () => undefined,
  });
  const host = createPiHttpHost({ cwd: layout.agents.assistant, layout, dataDir: join(root, "data"), bridgeFactory });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi`;
  const fileUrl = (path: string, scope = "assistant") => `${base}/files/download?${new URLSearchParams({ scope, path })}`;
  try {
    const bytes = Buffer.from([0, 255, 192, 100, 10]);
    const upload = () => fetch(`${base}/files?scope=assistant&name=${encodeURIComponent("测试.bin")}`, { method: "POST", body: bytes });
    const response = await upload();
    assert.equal(response.status, 201);
    const attachment = await response.json() as PiFileReference;
    assert.equal(attachment.name, "测试.bin");
    assert.equal(attachment.size, bytes.length);
    const second = await (await upload()).json() as PiFileReference;
    assert.notEqual(attachment.path, second.path, "duplicate names never overwrite earlier uploads");
    const listed = await (await fetch(`${base}/files?scope=assistant&path=${encodeURIComponent(attachment.path.split("/").slice(0, -1).join("/"))}`)).json();
    assert.deepEqual(listed.files, [{ name: "测试.bin", path: attachment.path, size: bytes.length, directory: false }]);
    const turn = await fetch(`${base}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "files", prompt: "Copy my attachment", attachments: [attachment] }),
    });
    const events = await turn.text();
    assert.match(modelPrompt, /<attached_workspace_files>/);
    assert.ok(modelPrompt.includes(join(layout.agents.assistant, attachment.path)));
    assert.ok(!events.includes("attached_workspace_files"), "model context does not pollute the visible user message");
    const download = await fetch(fileUrl("result.bin"));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    await mkdir(join(layout.agents.assistant, ".agentsphere"));
    await writeFile(join(layout.agents.assistant, ".agentsphere/access.json"), "private");
    await writeFile(join(root, "outside.txt"), "outside");
    await symlink(root, join(layout.agents.assistant, "escape"));
    await symlink(join(root, "outside.txt"), join(layout.agents.assistant, "linked.txt"));
    await link(join(root, "outside.txt"), join(layout.agents.assistant, "hardlink.txt"));
    for (const path of ["../outside.txt", "/etc/passwd", ".agentsphere/access.json", "escape/outside.txt", "linked.txt", "hardlink.txt", "a\\..\\outside.txt"]) {
      assert.ok([400, 403].includes((await fetch(fileUrl(path))).status), path);
    }
    const visible = await (await fetch(`${base}/files?scope=assistant`)).json();
    assert.ok(!visible.files.some((file: { name: string }) => [".agentsphere", "escape", "linked.txt", "hardlink.txt"].includes(file.name)));
    assert.equal((await fetch(fileUrl("missing.txt"))).status, 404);
    assert.equal((await fetch(`${base}/files?scope=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/files?scope=assistant`, { headers: { origin: "https://untrusted.example" } })).status, 403);

    for (const bad of [[{ ...attachment, scope: "builder" }], [{ scope: "assistant", path: ".agentsphere/access.json" }], "invalid", Array(11).fill(attachment)]) {
      modelPrompt = "";
      const rejected = await fetch(`${base}/prompt`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "read", attachments: bad }),
      });
      assert.match(await rejected.text(), /run.error/);
      assert.equal(modelPrompt, "", "invalid attachments must not reach the engine");
    }

    const huge = await fetch(`${base}/files?scope=assistant&name=huge.bin`, { method: "POST", body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) });
    assert.equal(huge.status, 413);
    // A chunked request has no Content-Length: the streaming body cap must still apply.
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/files?scope=assistant&name=chunked.bin`, { method: "POST", headers: { "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    });
    assert.equal(chunkedStatus, 413);
    assert.equal((await fetch(`${base}/files?scope=assistant&name=..%2Fevil`, { method: "POST", body: "x" })).status, 400);
    // A planted uploads symlink must never receive writes.
    await symlink(root, join(layout.agents.builder, "uploads"));
    assert.equal((await fetch(`${base}/files?scope=builder&name=evil`, { method: "POST", body: "x" })).status, 403);
    // Replacing the entire role directory is also a symlink escape, not a new trusted root.
    await rm(layout.agents.planner, { recursive: true });
    await symlink(root, layout.agents.planner);
    assert.equal((await fetch(`${base}/files?scope=planner`)).status, 403);
    assert.equal((await fetch(`${base}/files?scope=planner&name=evil`, { method: "POST", body: "x" })).status, 403);
  } finally {
    host.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
