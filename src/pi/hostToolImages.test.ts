import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshInstallation } from "./dshHarness.ts";
import { mcpPiTools } from "./mcpTool.ts";
import { sdkMcpResponse } from "./cliHarness.ts";
import { createCodexAppServer } from "./codexAppServer.ts";
import type { HostToolResult } from "./mcpServers.ts";

// A valid 1×1 PNG; exact bytes must survive the public engine tool-result protocols.
const image = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ioAAAAASUVORK5CYII=" };
const spec = { name: "browser_screenshot", description: "Screenshot", inputSchema: { type: "object", properties: {} } };

test("Pi, Claude and Codex tool responses preserve model image bytes alongside text", async () => {
  const output: HostToolResult = { text: "Viewport", isError: false, images: [image] };
  const toolkit = { specs: [spec], run: async () => output };
  const [tool] = mcpPiTools(toolkit);
  const content = [{ type: "text", text: "Viewport" }, { type: "image", ...image }];
  assert.deepEqual((await tool.execute("call", {}, undefined, undefined as never, undefined as never)).content, content);
  const claude = await sdkMcpResponse({ id: 1, method: "tools/call", params: { name: spec.name } }, { name: "raytone", tools: [spec], run: toolkit.run }, new AbortController().signal);
  assert.deepEqual(claude.result, { content, isError: false });
  const sent: Record<string, any>[] = [];
  const codex = createCodexAppServer({ cwd: "/workspace", prompt: "inspect", signal: new AbortController().signal,
    hostTools: toolkit, emit() {}, onSessionId() {}, onPermission: async () => true });
  const push = (message: Record<string, unknown>) => codex.push(message, value => sent.push(value));
  push({ id: "thread", result: { thread: { id: "thread" } } });
  push({ id: 2, method: "item/tool/call", params: { threadId: "thread", callId: "image", tool: spec.name, arguments: {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.find(item => item.id === 2)?.result, { success: true, contentItems: [
    { type: "inputText", text: "Viewport" }, { type: "inputImage", imageUrl: `data:image/png;base64,${image.data}` },
  ] });
});

let dshModule: string | undefined;
try { dshModule = createRequire(dshInstallation()).resolve("@deepseek-ai/dsh-mcp-client"); } catch { /* optional local engine */ }
test("installed DSH bridge projects image attachments and reports models without image input", { skip: !dshModule && "pinned DSH is not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-dsh-images-"));
  const path = join(dir, "tool.sock");
  const server = createServer(socket => socket.once("data", () => socket.end(JSON.stringify({ text: "Viewport", images: [image], isError: false }) + "\n")));
  await new Promise<void>(resolve => server.listen(path, resolve));
  const pluginPath = "./runtime/dshPlugin.mjs";
  const { apply } = await import(pluginPath);
  let tool: any, vision = true, saved = 0;
  const attachment = { id: "fixture-image", mediaType: "image/png" };
  try {
    await apply({ on() {}, provide() {}, approval: {}, tools: { guard() {}, register(value: unknown) { tool = value; } },
      get(name: string) {
        if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: vision ? ["text", "image"] : ["text"] }) };
        if (name === "attachments") return { saveImages: async (images: { data: Buffer; mediaType: string }[]) => {
          saved++; assert.equal(images[0].data.toString("base64"), image.data); return [attachment];
        } };
      },
    }, { socketPath: path, tools: [spec], mcpClientModule: dshModule });
    const exec = { signal: new AbortController().signal, callId: "shot", agent: { session: { id: "fixture", requestHeader: () => ({ config: { provider: "test", model: "test" } }) } } };
    const project = async () => {
      const value = await tool.execute({}, exec);
      return tool.projectContent(exec, { value, content: tool.output.render({}, value), isError: false });
    };
    assert.deepEqual(await project(), [{ type: "text", text: "Viewport" }, { type: "image", attachment }]);
    vision = false;
    assert.match(JSON.stringify(await project()), /does not declare image input/);
    assert.equal(saved, 1, "unsupported model must not store an unused image");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
