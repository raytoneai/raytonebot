// Real Chromium and installed engines; scripted loopback providers, no external inference.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createBrowserService } from "../../src/pi/browser/browserService.ts";
import { createPiRuntimeController } from "../../src/pi/piHost.ts";
import { runCodex, runClaudeCode } from "../../src/pi/cliHarness.ts";
import { dshInstallation, runDsh } from "../../src/pi/dshHarness.ts";
import { BROWSER_TOOL_SPECS } from "../../src/pi/browser/browserTools.ts";

const root = mkdtempSync(join(tmpdir(), "rtb-vision-transport-"));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function* objects(value: any): Generator<any> {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) yield value;
  for (const item of Object.values(value)) yield* objects(item);
}
function images(body: unknown) {
  return [...objects(body)].flatMap(value => {
    const url = value.type === "image_url" ? value.image_url?.url : value.type === "input_image" ? value.image_url : undefined;
    const data = typeof url === "string" && url.startsWith("data:") ? url.split(",")[1]
      : value.type === "image" && value.source?.type === "base64" ? value.source.data : undefined;
    if (!data) return [];
    const bytes = Buffer.from(data, "base64");
    if (mode === "dsh") normalizedImage = bytes;
    return [hash(bytes)];
  });
}
const reports: any[] = [];
let mode = "", snapshotId = "", calls = 0, received: string[] = [], produced: string[] = [], failures: string[] = [], offered: string[] = [];
let sourceImage: Buffer | undefined, normalizedImage: Buffer | undefined;
const provider = createServer(async (req, res) => {
  if (req.method === "GET") { res.setHeader("content-type", "text/html"); res.end('<title>Visual proof</title><h1 style="color:navy">Browser vision</h1><canvas id="chart" width="320" height="160"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="orange";c.fillRect(20,30,230,90)</script>'); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    // Exercise DSH's documented inline fallback for compatible services without Files API.
    if (req.url?.endsWith("/files")) { res.writeHead(404); res.end("Files API unavailable on this fixture"); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.stream === false && mode === "pi") { res.end(JSON.stringify({ choices: [{ message: { content: "Image transport" } }] })); return; }
    calls++; received.push(...images(body));
    const tools = [...objects(body.tools)];
    offered = tools.filter(value => typeof value.name === "string").map(value => value.name);
    const name = offered.find(name => name.endsWith("browser_screenshot"));
    assert.ok(name, `Screenshot tool missing: ${offered}`);
    const tool = calls === 1;
    const args = JSON.stringify({ snapshotId });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: any, named = false) => res.write(`${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
    if (req.url?.includes("responses")) {
      const namespace = (body.tools ?? []).find((t: any) => t.type === "namespace" && t.tools?.some((v: any) => v.name === name))?.name;
      const item = tool ? { id: "call-item", type: "function_call", call_id: "shot", name, arguments: args, ...(namespace ? { namespace } : {}) }
        : { id: "done", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Image transport complete.", annotations: [] }] };
      const response = { id: `response-${calls}`, object: "response", model: body.model, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, true);
      send({ type: "response.output_item.done", output_index: 0, item }, true);
      send({ type: "response.completed", response }, true);
    } else if (req.url?.includes("messages")) {
      send({ type: "message_start", message: { id: `message-${calls}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }, true);
      send({ type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "shot", name, input: {} } : { type: "text", text: "" } }, true);
      send({ type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text: "Image transport complete." } }, true);
      send({ type: "content_block_stop", index: 0 }, true);
      send({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, true);
      send({ type: "message_stop" }, true);
    } else {
      const delta = tool ? { role: "assistant", reasoning_content: "", tool_calls: [{ index: 0, id: "shot", type: "function", function: { name, arguments: args } }] } : { role: "assistant", content: "Image transport complete." };
      for (const [part, finish] of [[delta, null], [{}, tool ? "tool_calls" : "stop"]]) send({ id: `completion-${calls}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: part, finish_reason: finish }] });
      res.write("data: [DONE]\n\n");
    }
    res.end();
  } catch (error) { failures.push(String(error)); res.writeHead(500); res.end("Fixture failure"); }
});
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const port = (provider.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;
const browser = createBrowserService({ dataDir: join(root, "browser"), allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
const wrapped = { ...browser, toolsFor(context: any) {
  const toolkit = browser.toolsFor(context)!;
  return { ...toolkit, async run(...args: Parameters<typeof toolkit.run>) {
    const result = await toolkit.run(...args);
    if (result.images?.[0]) sourceImage = Buffer.from(result.images[0].data, "base64");
    produced.push(...(result.images ?? []).map(image => hash(Buffer.from(image.data, "base64"))));
    return result;
  } };
} };
try {
  for (mode of (process.argv[2] ? [process.argv[2]] : ["pi", "codex", "claude", "dsh"])) {
    calls = 0; received = []; produced = []; failures = []; offered = [];
    const cwd = join(root, mode); mkdirSync(cwd);
    const conversationId = `vision-${mode}`;
    const toolkit = wrapped.toolsFor({ conversationId, agent: "assistant", ask: async () => null, saveDownload: async () => "unused" });
    const opened = await toolkit.run("browser_open", { url: `http://127.0.0.1:${port}/fixture` });
    assert.equal(opened.isError, false, opened.text);
    snapshotId = /^Snapshot: (.+)$/m.exec(opened.text)![1];
    let host: ReturnType<typeof createPiRuntimeController> | undefined;
    const events: any[] = [];
    let normalizedPixels: unknown;
    try {
      const signal = AbortSignal.timeout(45000);
      if (mode === "pi") {
        host = createPiRuntimeController({ cwd, dataDir: join(root, "data"), sandboxed: false, browser: wrapped });
        const config = { provider: "vision-fixture", model: "deepseek-flash", apiKey: "local-only", providerDefinition: { id: "vision-fixture", name: "Loopback fixture", protocol: "openai-compatible" as const, baseUrl, models: ["deepseek-flash"], authMode: "required" as const } };
        await host.configure({ ...config, conversationId });
        await host.runPrompt({ conversationId, prompt: "Inspect the current screenshot.", provider: config.provider, model: config.model, agentPreset: "assistant", permissionMode: "request" }, event => events.push(event), { signal });
      } else {
        const common = { cwd, prompt: "Inspect the current screenshot.", permissionMode: "request" as const, signal, emit: (event: any) => events.push(event), onSessionId() {},
          onPermission: async (request: any) => { request.startExecution(); return true as const; },
          hostTools: { specs: BROWSER_TOOL_SPECS.filter(spec => spec.name === "browser_screenshot"), run: toolkit.run } };
        if (mode === "codex") await runCodex({ ...common, provider: { name: "Loopback fixture", baseUrl, apiKey: "local-only", model: "gpt-5.4" } });
        if (mode === "claude") await runClaudeCode({ ...common, provider: { baseUrl, apiKey: "local-only", model: "claude-sonnet-4-5" } });
        if (mode === "dsh") await runDsh({ ...common, home: join(root, "dsh-data"), systemPrompt: "Local protocol check.", provider: { baseUrl, apiKey: "local-only", model: "deepseek-flash" } });
      }
      assert.equal(produced.length, 1, "Screenshot must execute exactly once");
      if (mode === "dsh") {
        assert.ok(sourceImage && normalizedImage, "DSH must send actual inline image data");
        const installation = createRequire(dshInstallation());
        const sharp = createRequire(installation.resolve("@deepseek-ai/dsh-attachment-local"))("sharp");
        const a = await sharp(sourceImage).raw().toBuffer({ resolveWithObject: true });
        const b = await sharp(normalizedImage).raw().toBuffer({ resolveWithObject: true });
        assert.equal(a.info.width, b.info.width); assert.equal(a.info.height, b.info.height); assert.equal(a.data.length, b.data.length);
        let error = 0; for (let i = 0; i < a.data.length; i++) error += Math.abs(a.data[i] - b.data[i]);
        const meanAbsoluteError = error / a.data.length;
        assert.ok(meanAbsoluteError < 2, `DSH image changed excessively: ${meanAbsoluteError}`);
        normalizedPixels = { width: b.info.width, height: b.info.height, meanAbsoluteError, reason: "DSH native attachment JPEG normalization" };
        writeFileSync(new URL("./viewport.jpg", import.meta.url), sourceImage);
        writeFileSync(new URL("./dsh-normalized.jpg", import.meta.url), normalizedImage);
      } else assert.ok(received.includes(produced[0]), "Provider must receive exact browser image bytes");
      assert.equal(failures.length, 0);
    } catch (error) { failures.push(String(error)); }
    finally { host?.dispose(); }
    const report = { engine: mode, providerRequests: calls, produced, received, normalizedPixels, pass: failures.length === 0, failures,
      eventErrors: events.filter(event => /error/.test(event.type)).map(event => ({ type: event.type, message: event.payload?.message ?? event.error })) };
    reports.push(report); console.log(JSON.stringify(report));
  }
} finally {
  await browser.stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  writeFileSync(new URL(`./${process.argv[2] ? process.argv[2] + "-" : "model-"}transport-report.json`, import.meta.url), JSON.stringify(reports, null, 2) + "\n");
}
assert.ok(reports.length > 0 && reports.every(report => report.pass));
