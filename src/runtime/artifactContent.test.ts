import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAgentUXViewModel } from "@agent-ux/render-core";
import type { AgentUXEvent } from "@agent-ux/protocol";
import { artifactBody, artifactEventForReplay } from "./artifactContent.ts";
import { htmlPreviewDocument } from "../components/agent-preview/outputframe/htmlPreview.ts";
import { normalizeOutputPanelRequest } from "../components/agent-preview/outputframe/panelItem.ts";
import { createServer } from "vite";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";

test("structured artifacts survive the actual renderer without corrupting streaming text or input events", () => {
  const source = readFileSync(new URL("../fixtures/agentux/artifacts-action-correlation.events.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line) as AgentUXEvent);
  const snapshot = JSON.stringify(source);
  const view = createAgentUXViewModel(source.map(artifactEventForReplay));
  const artifact = view.timeline.find((item) => item.kind === "artifact")!;
  assert.equal(artifact.kind, "artifact");
  if (artifact.kind !== "artifact") return;
  const body = artifactBody(artifact)!;
  assert.equal(JSON.parse(body).fields[0].defaultValue, "ada@example.com");
  assert.equal(body.includes("[object Object]"), false);
  assert.equal(JSON.stringify(source), snapshot);
  const text = { ...source[2], payload: { artifactId: "text", format: "text", delta: "hello" } } as AgentUXEvent;
  assert.equal(artifactEventForReplay(text), text);
  for (const value of [false, 0, null, [1, 2]]) assert.deepEqual(JSON.parse(artifactBody({ data: value })!), value);
});

test("preview policy precedes untrusted full documents; missing files do not fabricate content", () => {
  const body = '<!doctype html><html><head><script>example()</script></head><body>Report</body></html>';
  const document = htmlPreviewDocument(body);
  assert.ok(document.indexOf('Content-Security-Policy') < document.indexOf('<script>'));
  assert.match(document, /connect-src 'none'/);
  assert.match(document, /base-uri 'none'; form-action 'none'/);
  assert.ok(document.endsWith(body));
  assert.equal(normalizeOutputPanelRequest("missing.html").body, undefined);
});

test("code and diff previews preserve tool artifact content, including fences, whitespace and empty files", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { artifactCodePreview, artifactDiffPreview } = await server.ssrLoadModule("/src/components/agent-preview/outputframe/artifactPreview.ts");
    const { workspaceCopy } = await server.ssrLoadModule("/src/i18n/copy/workspace.ts");
    const copy = workspaceCopy.en.outputFrame;
    const source = "\n/* Example:\n```md\n# Inside a comment\n```\n*/\nexport const answer = 41;\n\n";
    const diff = " 6 */\n-7 export const answer = 41;\n+7 export const answer = 42;\n";
    const adapter = createPiEventAdapter({ runId: "preview" });
    adapter.apply({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "example.js", content: source } });
    adapter.apply({ type: "tool_execution_end", toolCallId: "write", toolName: "write", result: { content: [{ type: "text", text: "Written" }] } });
    adapter.apply({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "example.js", oldText: "41", newText: "42" } });
    adapter.apply({ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: { details: { diff } } });
    const artifacts = createAgentUXViewModel(adapter.events).timeline.filter(item => item.kind === "artifact");
    assert.equal(artifacts.length, 2);
    const [written, edited] = artifacts;
    assert.deepEqual({ code: artifactCodePreview(written, copy), diff: artifactDiffPreview(edited, copy) },
      { code: { code: source, lang: "javascript" }, diff });
    assert.equal(artifactCodePreview({ ...written, content: "" }, copy).code, "");
    assert.equal(artifactDiffPreview({ ...edited, content: undefined }, copy), copy.artifactMetadataEmpty);
  } finally { await server.close(); }
});
