import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let modules: Record<string, any>;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  modules = {};
  for (const path of ["components/agent-preview/outputframe/renderKind", "components/agent-preview/outputframe/artifactPreview", "components/agent-preview/outputframe/openedItemBody", "components/agent-preview/outputframe/OutputContent", "components/agent-preview/outputframe/OutputPanelModal", "exported-project", "i18n/uiCopy"]) {
    Object.assign(modules, await server.ssrLoadModule(`/src/${path}`));
  }
});
after(async () => { await server?.close(); });
const patch = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-<script>old</script>\n+new\n";
const item = { id: "patch", kind: "file", title: "change.patch", body: patch };

test("patch files, explicit languages and real patch bodies render as escaped colored text", () => {
  const copy = modules.uiCopy.zh.workspace.outputFrame;
  for (const file of [item, { ...item, title: "CHANGE.DIFF" }, { ...item, title: "changes", language: "patch" }]) {
    assert.equal(modules.outputItemRenderKind(file), "diff");
    assert.equal(modules.outputItemModalRenderer(file), "diff");
    assert.equal(modules.resolveArtifactRenderer({ title: file.title, artifactKind: "file", content: patch }, "auto"), "diff");
  }
  const html = renderToStaticMarkup(modules.renderOpenedOutputBody(item, "diff", "patch", copy));
  assert.match(html, /data-diff-kind="delete"/);
  assert.match(html, /data-diff-kind="add"/);
  assert.match(html, /&lt;script&gt;old/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(renderToStaticMarkup(modules.renderOpenedOutputBody(item, "code", "text", copy)), /class="unified-diff"/);
  assert.doesNotMatch(renderToStaticMarkup(modules.renderOpenedOutputBody({ ...item, body: "--- prose\n+++ prose" }, "code", "text", copy)), /class="unified-diff"/);
});

test("inline and expanded previews expose close for a single file without adding a tab row", () => {
  for (const locale of ["zh", "en", "ja"]) {
    const copy = modules.uiCopy[locale].workspace.outputFrame;
    const props = { project: modules.project, source: "artifact", renderer: "diff", copy, openItems: [item], tools: [], artifacts: [], onOpenArtifact() {}, onCloseOpenItem() {} };
    const html = renderToStaticMarkup(createElement(modules.OutputContent, props));
    assert.ok(html.includes(copy.closeFile(item.title)));
    assert.doesNotMatch(html, /class="output-tabs"/);
    const readonly = renderToStaticMarkup(createElement(modules.OutputContent, { ...props, onCloseOpenItem: undefined }));
    assert.ok(!readonly.includes(copy.closeFile(item.title)));
  }
  const modal = renderToStaticMarkup(createElement(modules.OutputPanelModal, { items: [item], onCloseItem() {}, onClose() {} }));
  assert.match(modal, /关闭 change.patch/);
  assert.doesNotMatch(modal, /class="output-tabs"/);
});
