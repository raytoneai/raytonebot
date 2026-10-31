import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

const origin = "published_version_11111111-1111-1111-1111-111111111111";
const second = "published_version_22222222-2222-2222-2222-222222222222";
const pdfOrigin = "published_version_33333333-3333-3333-3333-333333333333";
const conversationId = "conversation-version-browser";
const longMarkdown = "# Delivery A\n\nThis ordinary paragraph keeps reading naturally beside https://raw.githubusercontent.com/raytonebot/raytonebot/main/docs/a-very-long-source-reference-that-must-wrap-within-the-reader-width.txt .";

/**
 * A narrow real-browser probe for the opened Output owner. The host is mocked at the HTTP edge;
 * no model, conversation, or storage is used. This keeps the check focused on the UI contract:
 * saved A/B bytes stay selectable while the current workspace revision remains editable.
 */
test("saved Output versions survive current writes at a 390px viewport", {
  skip: !findHeadlessShell() && "Chromium not installed",
  timeout: 60_000,
}, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-output-versions-browser-"));
  const requests: { artifactId?: string; versionId?: string; title?: string }[] = [];
  const metadataRequests: string[] = [];
  let failedMetadata = false;
  const server = await createServer({
    root: process.env.RAYTONEBOT_TEST_ROOT ?? process.cwd(),
    configFile: false,
    cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [react(), {
      name: "output-versions-browser-test-libs",
      resolveId(id: string) { return id.startsWith("virtual:sandbox-lib/") ? `\0${id}` : undefined; },
      load(id: string) { return id.startsWith("\0virtual:sandbox-lib/") ? "export const code=''; export const exports={};" : undefined; },
    }, {
      name: "output-versions-browser-test",
      configureServer(vite) {
        vite.middlewares.use("/output-versions-test", async (_req, res) => {
          res.setHeader("content-type", "text/html");
          res.end(await vite.transformIndexHtml("/output-versions-test", `<!doctype html>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <div id="root"></div>
            <script type="module">
              import { createElement as h, useState } from 'react';
              import { createRoot } from 'react-dom/client';
              import { OpenedOutputItem } from '/src/components/agent-preview/outputframe/OutputTabs.tsx';
              import { OutputPanelModal } from '/src/components/agent-preview/outputframe/OutputPanelModal.tsx';
              import { ShellExtrasProvider } from '/src/components/shell/ShellExtras.tsx';
              import { LocaleProvider, useCopy } from '/src/i18n/LocaleContext.tsx';
              import '/src/styles/app.css';

              const A = 'published_version_11111111-1111-1111-1111-111111111111';
              const B = 'published_version_22222222-2222-2222-2222-222222222222';
              const P = 'published_version_33333333-3333-3333-3333-333333333333';
              const params = new URLSearchParams(location.search);
              const formMode = params.has('form');
              const base = {
                id: 'artifact:' + A, kind: 'file', title: formMode ? 'form.md' : 'report.md', language: 'markdown',
                artifactId: A, versionOriginArtifactId: A,
                conversationId: params.has('failure') ? 'conversation-version-browser-fail' : formMode ? 'conversation-version-browser-form' : 'conversation-version-browser',
                versionSelection: 'version',
                workspacePath: formMode ? '/private/work/form.md' : '/private/work/report.md',
              };
              const pdf = { ...base, id: 'artifact:' + P, artifactId: P, versionOriginArtifactId: P, title: 'report.pdf', language: 'pdf', workspacePath: '/private/work/report.pdf' };
              function Probe() {
                const [item, setItem] = useState(params.has('pdf') ? pdf : base);
                const [modal, setModal] = useState(false);
                const copy = useCopy().workspace.outputFrame;
                const current = () => setItem(value => ({ ...value, artifactId: 'ordinary_write', revision: 'ordinary_write', body: undefined }));
                const onOpenFile = request => setItem(value => ({ ...value, ...request }));
                const extras = { workspaceScope: 'assistant', workspaceSharedAvailable: false,
                  workspace: { agents: { assistant: '/work' }, shared: '/work' },
                  artifactForms: { conversationId: 'conversation-version-browser', result: () => undefined,
                    openResult: () => {}, submit: async () => {} }, onOpenFile };
                return h(ShellExtrasProvider, { value: extras },
                  h('main', { className: 'preview-frame', 'data-owner-artifact': item.artifactId,
                    'data-owner-origin': item.versionOriginArtifactId || '', 'data-owner-selection': item.versionSelection,
                    'data-owner-source': item.versionSource ? item.versionSource.scope + ':' + item.versionSource.path : '' },
                    h('button', { type: 'button', onClick: current }, 'Publish ordinary write'),
                    h('button', { type: 'button', onClick: () => setModal(true) }, 'Open modal'),
                    h(OpenedOutputItem, { item, copy }),
                    modal ? h(OutputPanelModal, { items: [item], activeId: item.id, onClose: () => setModal(false) }) : null));
              }
              createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: 'en' }, h(Probe)));
            </script>`));
        });
        vite.middlewares.use(async (req, res, next) => {
          const requestUrl = new URL(req.url ?? "/", "http://raytonebot.test");
          if (!requestUrl.pathname.startsWith("/__agentcanvas/pi")) { next(); return; }
          if (requestUrl.pathname === "/__agentcanvas/pi/artifacts/versions") {
            metadataRequests.push(requestUrl.search);
            if (requestUrl.searchParams.get("conversationId") === "conversation-version-browser-fail" && !failedMetadata) {
              failedMetadata = true;
              res.statusCode = 503;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: "metadata unavailable" }));
              return;
            }
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            const pdf = requestUrl.searchParams.get("artifactId") === pdfOrigin;
            const form = requestUrl.searchParams.get("conversationId") === "conversation-version-browser-form" || requestUrl.searchParams.get("path") === "form.md";
            res.end(JSON.stringify({ selectedVersionId: pdf ? "pdf-a" : "v-a", versions: [
              { versionId: pdf ? "pdf-a" : "v-a", artifactId: pdf ? pdfOrigin : origin, createdAt: 1_700_000_000_000, size: 3, sha256: "a" },
              ...(pdf ? [] : [{ versionId: "v-b", artifactId: second, createdAt: 1_700_000_000_000, size: 3, sha256: "b" }]),
            ], source: { scope: "assistant", path: pdf ? "report.pdf" : form ? "form.md" : "report.md" } }));
            return;
          }
          if (requestUrl.pathname === "/__agentcanvas/pi/files/download") {
            const artifactId = requestUrl.searchParams.get("artifactId") ?? undefined;
            const versionId = requestUrl.searchParams.get("versionId") ?? undefined;
            requests.push({ artifactId, versionId, title: requestUrl.search });
            res.statusCode = 200;
            res.setHeader("content-type", versionId === "pdf-a" ? "application/pdf" : "text/plain");
            const form = requestUrl.searchParams.get("conversationId") === "conversation-version-browser-form" || requestUrl.searchParams.get("path") === "form.md";
            const formBody = JSON.stringify({ kind: "raytone-form", version: 1, title: "Saved form", prompt: "This should remain read-only", fields: [{ id: "name", label: "Name", type: "text" }] });
            res.end(versionId === "pdf-a" ? "%PDF-1.4\n% saved PDF\n" : form ? formBody : versionId === "v-b" ? "# Delivery B\n" : versionId === "v-a" ? longMarkdown : "# Current workspace\n");
            return;
          }
          next();
        });
      },
    }],
  });
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls!.local[0];
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${baseUrl}output-versions-test`, { waitUntil: "domcontentloaded" });
      await page.getByText("Delivery A", { exact: true }).waitFor();
      const selector = page.locator("[data-version-selector] select");
      assert.equal(await selector.count(), 1);
      assert.equal(await selector.locator("option").count(), 3);
      const reader = page.locator('.opened-output-item[data-versioned="true"] > .markdown-preview').first();
      const paragraphLayout = await reader.locator("p").first().evaluate(element => {
        const readerElement = element.closest(".markdown-preview") as HTMLElement;
        return { paragraphWidth: element.getBoundingClientRect().width, readerWidth: readerElement.getBoundingClientRect().width, scrollWidth: readerElement.scrollWidth, clientWidth: readerElement.clientWidth };
      });
      assert.ok(paragraphLayout.paragraphWidth <= paragraphLayout.readerWidth + 1, "saved Markdown paragraphs stay inside the reader width");
      assert.ok(paragraphLayout.scrollWidth <= paragraphLayout.clientWidth + 1, "long saved URLs do not widen the reader");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator("a[download='report.md']").getAttribute("href"), `/__agentcanvas/pi/files/download?conversationId=${conversationId}&artifactId=${origin}&versionId=v-a`);
      await selector.selectOption("v-b");
      await page.getByText("Delivery B", { exact: true }).waitFor();
      assert.match(await page.locator("[data-owner-selection]").getAttribute("data-owner-selection") ?? "", /version/);
      await selector.selectOption("current");
      await page.getByText("Current workspace", { exact: true }).waitFor();
      assert.equal(await page.locator("[data-owner-selection]").getAttribute("data-owner-selection"), "current");
      assert.equal(await page.locator("[data-owner-source]").getAttribute("data-owner-source"), "assistant:report.md", "the owner retains the canonical source for current mode");
      assert.equal(requests.some(request => request.artifactId === undefined && request.versionId === undefined && request.title?.includes("scope=assistant") && request.title?.includes("path=report.md")), true, "source metadata resolves current bytes without a host path alias");
      assert.equal(await page.getByRole("button", { name: "Edit document", exact: true }).count(), 1, "current workspace files retain the edit entry point");
      await page.getByRole("button", { name: "Publish ordinary write", exact: true }).click();
      await page.getByText("Current workspace", { exact: true }).waitFor();
      assert.equal(await page.locator("[data-owner-origin]").getAttribute("data-owner-origin"), origin);
      assert.equal(await selector.count(), 1, "the selector remains after artifactId changes to a normal write");
      await selector.selectOption("v-a");
      await page.getByText("Delivery A", { exact: true }).waitFor();
      assert.equal(requests.some(request => request.artifactId === origin && request.versionId === "v-a"), true);
      assert.equal(metadataRequests.some(query => query.includes(`conversationId=${conversationId}`) && query.includes(`artifactId=${origin}`)), true);

      await page.getByRole("button", { name: "Open modal", exact: true }).click();
      const modal = page.locator('.preview-frame .artifact-frame[data-expanded="true"][data-output-modal="true"]');
      await modal.waitFor();
      const modalSelector = modal.locator("[data-version-selector]");
      await modalSelector.waitFor();
      const modalReader = modal.locator('.opened-output-item[data-versioned="true"] > .markdown-preview');
      const modalParagraphLayout = await modalReader.locator("p").first().evaluate(element => {
        const readerElement = element.closest(".markdown-preview") as HTMLElement;
        return { paragraphWidth: element.getBoundingClientRect().width, readerWidth: readerElement.getBoundingClientRect().width, scrollWidth: readerElement.scrollWidth, clientWidth: readerElement.clientWidth };
      });
      assert.ok(modalParagraphLayout.paragraphWidth <= modalParagraphLayout.readerWidth + 1, "modal saved Markdown paragraphs stay inside the reader width");
      assert.ok(modalParagraphLayout.scrollWidth <= modalParagraphLayout.clientWidth + 1, "modal long URLs do not widen the reader");
      const layout = await modalSelector.evaluate(element => {
        const select = element.querySelector("select");
        const selectorRect = element.getBoundingClientRect();
        const selectRect = select?.getBoundingClientRect();
        const panelRect = element.closest(".artifact-frame")?.getBoundingClientRect();
        return {
          clientHeight: element.clientHeight,
          selectHeight: selectRect?.height ?? 0,
          selectorBottom: selectorRect.bottom,
          panelBottom: panelRect?.bottom ?? 0,
          viewportHeight: window.innerHeight,
        };
      });
      assert.ok(layout.clientHeight >= layout.selectHeight, "expanded saved-version selector keeps its intrinsic row");
      assert.ok(layout.selectorBottom <= layout.panelBottom + 1 && layout.selectorBottom <= layout.viewportHeight + 1, "expanded selector remains visible");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.RAYTONEBOT_OUTPUT_VERSION_SCREENSHOT) {
        await page.waitForTimeout(220);
        const screenshotPath = join(process.cwd(), "output/first-batch-optimizations-2026-11-01/version-mobile-ui-regression.png");
        mkdirSync(join(process.cwd(), "output/first-batch-optimizations-2026-11-01"), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: false });
      }
      await modalSelector.locator("select").selectOption("current");
      await modal.getByText("Current workspace", { exact: true }).waitFor();
      assert.equal(await modal.getByRole("button", { name: "Edit document", exact: true }).count(), 1, "current Markdown keeps editing inside the expanded owner");
    } finally { await page.close(); }

    const formPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await formPage.goto(`${baseUrl}output-versions-test?form=1`, { waitUntil: "domcontentloaded" });
      await formPage.getByText("raytone-form", { exact: false }).waitFor();
      assert.equal(await formPage.getByRole("button", { name: "Submit to conversation", exact: true }).count(), 0, "saved raytone-form JSON stays ordinary read-only content");
      const formSelector = formPage.locator("[data-version-selector] select");
      await formSelector.selectOption("current");
      await formPage.getByRole("button", { name: "Submit to conversation", exact: true }).waitFor();
      assert.equal(await formPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await formPage.close(); }

    const pdfPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await pdfPage.goto(`${baseUrl}output-versions-test?pdf=1`, { waitUntil: "domcontentloaded" });
      await pdfPage.locator("[data-version-selector] select").waitFor();
      await pdfPage.waitForTimeout(150);
      assert.equal(requests.some(request => request.artifactId === pdfOrigin && request.versionId === "pdf-a"), true, "PDF preview downloads the selected saved version");
      await pdfPage.getByRole("button", { name: "Open modal", exact: true }).click();
      const pdfModal = pdfPage.locator('.preview-frame .artifact-frame[data-expanded="true"][data-output-modal="true"]');
      await pdfModal.locator("[data-version-selector]").waitFor();
      const pdfLayout = await pdfModal.locator("[data-version-selector]").evaluate(element => ({
        clientHeight: element.clientHeight,
        selectHeight: element.querySelector("select")?.getBoundingClientRect().height ?? 0,
      }));
      assert.ok(pdfLayout.clientHeight >= pdfLayout.selectHeight, "expanded PDF keeps the selector row when no document actions exist");
      assert.equal(await pdfModal.getByRole("button", { name: "Edit document", exact: true }).count(), 0);
      assert.equal(await pdfPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await pdfPage.close(); }

    const failurePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const requestsBeforeFailure = requests.length;
      await failurePage.goto(`${baseUrl}output-versions-test?failure=1`, { waitUntil: "domcontentloaded" });
      await failurePage.getByRole("alert").waitFor();
      assert.doesNotMatch(await failurePage.locator("body").innerText(), /Current workspace/);
      assert.equal(requests.length, requestsBeforeFailure, "metadata failure never falls back to the current file");
      const metadataBeforeRetry = metadataRequests.length;
      await failurePage.getByRole("button", { name: /Retry|Reload|再试|重试|再試行/i }).click();
      await failurePage.getByText("Delivery A", { exact: true }).waitFor();
      assert.ok(metadataRequests.length > metadataBeforeRetry, "failed metadata can be retried");
      assert.equal(await failurePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await failurePage.close(); }
  } finally {
    await browser.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
