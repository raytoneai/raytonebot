import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConversationStore } from "../../src/pi/conversationStore.ts";
import { createPiEventAdapter } from "../../src/harness/adapters/piAdapter.ts";

const root = process.argv[2];
if (!root || !/\/raytone-pure-modules\.[A-Za-z0-9]+$/.test(root)) throw new Error("Expected this task's disposable directory");
const workspace = join(root, "workspaces", "agents", "assistant");
mkdirSync(workspace, { recursive: true });
const html = "<!doctype html><html><body><h1>Written input sentinel</h1><p>Exact synthetic tool input.</p></body></html>";
const readBody = "# Read result sentinel\n\nExact synthetic tool result.";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/p8AAAAASUVORK5CYII=";
writeFileSync(join(workspace, "read-notes.md"), readBody);
writeFileSync(join(workspace, "written-page.html"), html);
for (const name of ["chart-one.png", "chart-two.png"]) writeFileSync(join(workspace, name), Buffer.from(image, "base64"));

const id = "pi_tool_file_review";
const store = createConversationStore(`${root}/data`);
store.begin(id, "assistant", "");
store.setExtra(id, { title: "Tool file projection review", titleSource: "user", botId: "assistant" });
const adapter = createPiEventAdapter({ runId: "pure_file_review", now: 1 });
adapter.startUserMessage("Review these synthetic file tool receipts.");
for (const tool of [
  { id: "read", name: "read", args: { path: "read-notes.md" }, result: { content: [{ type: "text", text: readBody }] } },
  { id: "write", name: "write", args: { path: "written-page.html", content: html }, result: { content: [{ type: "text", text: "Successfully wrote synthetic HTML bytes." }] } },
  { id: "images", name: "read_image", args: { path: "chart-one.png" }, result: { images: [
    { path: "chart-one.png", src: `data:image/png;base64,${image}`, meta: "First supplied image" },
    { file: "chart-two.png", dataUrl: `data:image/png;base64,${image}`, meta: "Second supplied image" },
  ] } },
  { id: "failed", name: "write", args: { path: "failed-file.md", content: "Never written" }, result: { content: [{ type: "text", text: "Synthetic permission denied" }] }, isError: true },
]) {
  adapter.apply({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.args });
  adapter.apply({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: tool.result, isError: tool.isError });
}
adapter.finish();
for (const event of adapter.events) store.append(id, event);
store.flush(id);
console.log("Created one synthetic tool history and four temporary files; no model calls.");
