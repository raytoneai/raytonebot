import assert from "node:assert/strict";
import test from "node:test";
import { inlineMediaSource, MAX_PREVIEW_BYTES, mediaType, readPreviewBlob, workspaceFileUrl } from "./filePreview.ts";

test("file previews resolve role/shared references without guessing paths or loading external media", () => {
  const workspace = { root: "/work", shared: "/work/shared", agents: { assistant: "/work/agents/assistant", planner: "/work/agents/planner", builder: "/work/agents/builder" } };
  for (const [path, scope, relative] of [["report #1.html", "assistant", "report #1.html"], ["../../shared/图.png", "shared", "图.png"], ["/work/shared/clip.wav", "shared", "clip.wav"]]) {
    const url = new URL(workspaceFileUrl(path, "assistant", workspace)!, "http://localhost");
    assert.equal(url.searchParams.get("scope"), scope);
    assert.equal(url.searchParams.get("path"), relative);
  }
  assert.equal(workspaceFileUrl("/work/agents/assistant-other/private", "assistant", workspace), undefined);
  assert.equal(workspaceFileUrl("../../../private", "assistant", workspace), undefined);
  assert.equal(workspaceFileUrl("/work/agents/planner/private", "assistant", workspace), undefined);
  for (const value of ["https://outside.example/image.png", "//outside.example/image.png", "javascript:example()", "data:text/html,<script>example()</script>", "file:///etc/passwd", "demo image preview"]) assert.equal(inlineMediaSource(value), undefined);
  assert.equal(inlineMediaSource("data:image/png;base64,AA=="), "data:image/png;base64,AA==");
  assert.equal(mediaType("recording.WAV"), "audio/wav");
  assert.equal(mediaType("report.PDF"), "application/pdf");
  assert.equal(mediaType("misleading.svg", "PDF"), "application/pdf", "the PDF renderer must never receive an executable SVG Blob");
});

test("PDF previews preserve binary bytes and reject a renamed HTML file before embedding", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\n\0binary content\n%%EOF");
  const blob = await readPreviewBlob(new Response(bytes), "application/pdf");
  assert.equal(blob.type, "application/pdf");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  await assert.rejects(readPreviewBlob(new Response("<script>parent.alert(1)</script>"), "application/pdf"), /unavailable/);
  await assert.rejects(readPreviewBlob(new Response(""), "application/pdf"), /unavailable/);
});

test("preview reads preserve real bytes, reject missing files and bound both declared and chunked bodies", async () => {
  const bytes = new Uint8Array([0, 255, 1, 80, 65]);
  assert.deepEqual(new Uint8Array(await (await readPreviewBlob(new Response(bytes))).arrayBuffer()), bytes);
  await assert.rejects(readPreviewBlob(new Response("missing", { status: 404 })), /unavailable/);
  await assert.rejects(readPreviewBlob(new Response("", { headers: { "content-length": String(MAX_PREVIEW_BYTES + 1) } })), /too-large/);
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_PREVIEW_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readPreviewBlob(new Response(oversized)), /too-large/);
  assert.equal(cancelled, true, "over-limit streams stop reading instead of leaving a transfer alive");
});
