import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { createPiEventAdapter } from "../harness/adapters/piAdapter.ts";
import { piCancelledTurnEvents } from "../pi/piCancelledTurn.ts";

// Real owner rendering from serialized history; host restart persistence is tested in piHost.test.ts.
test("ChatFrame retains stopped and interrupted history after reload in every locale", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000,
}, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-stopped-history-"));
  const adapter = createPiEventAdapter({ runId: "saved-turn" });
  adapter.startUserMessage("Question before stopping");
  adapter.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer remains readable" } });
  const stoppedEvents = [...adapter.events, ...piCancelledTurnEvents(adapter.events)];
  const restartedEvents = [...adapter.events, ...piCancelledTurnEvents(adapter.events, "host_restart")];
  adapter.finish("success");
  const histories = { stopped: stoppedEvents, restarted: restartedEvents, completed: adapter.events };
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-markdown", "remark-gfm"] },
    plugins: [react(), { name: "stopped-history-test", configureServer(vite) {
      vite.middlewares.use("/stopped-history-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/stopped-history-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h } from 'react';
          import { createRoot } from 'react-dom/client';
          import { createAgentUXViewModel } from '@agent-ux/render-core';
          import { ChatFrame } from '/src/components/agent-preview/ChatFrame.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { IconSetProvider } from '/src/agentmatrix/IconSetContext.tsx';
          import { ShellExtrasProvider } from '/src/components/shell/ShellExtras.tsx';
          import { project } from '/src/exported-project.ts';
          import { cancelledTurnsForReplay } from '/src/runtime/cancelledTurns.ts';
          import { branchReplayEvents } from '/src/runtime/useMessageBranch.ts';
          import '/src/styles/app.css';
          const params = new URLSearchParams(location.search);
          const locale = params.get('locale') || 'en';
          const histories = ${JSON.stringify(histories)};
          const events = histories[params.get('state') || 'stopped'];
          const viewModel = createAgentUXViewModel(branchReplayEvents(cancelledTurnsForReplay(events, locale)));
          createRoot(document.getElementById('root')).render(h(IconSetProvider, null,
            h(LocaleProvider, { initialLocale: locale }, h(ShellExtrasProvider, { value: {} },
              h(ChatFrame, { project, viewModel, previewPrompt: "" })))));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    for (const width of [1280, 390]) for (const [locale, stopped, interrupted] of [
      ["en", "Run stopped", "Run interrupted"], ["zh", "本轮已停止", "本轮已中断"], ["ja", "実行停止", "実行中断"],
    ]) await t.test(`${locale}, ${width}px`, async () => {
      const page = await browser!.newPage({ viewport: { width: Number(width), height: 844 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5_000);
      const errors: string[] = [];
      page.on("pageerror", error => { errors.push(error.message); t.diagnostic(error.message); });
      for (const [state, label] of [["stopped", stopped], ["restarted", interrupted]]) {
        await page.goto(`${server.resolvedUrls!.local[0]}stopped-history-test?locale=${locale}&state=${state}`);
        const marker = page.locator('.step-item[data-status="cancelled"]');
        await marker.getByText(label, { exact: true }).waitFor();
        await page.reload();
        await marker.getByText(label, { exact: true }).waitFor();
        assert.equal(await marker.count(), 1);
        assert.equal(await marker.locator(".step-kind").count(), 0, "terminal markers have no technical session label");
        const screenshotDir = process.env.RAYTONEBOT_TEST_SCREENSHOT_DIR;
        if (screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true });
          await page.screenshot({ path: join(screenshotDir, `${locale}-${width}-${state}.png`), fullPage: true });
        }
        await page.getByText("Partial answer remains readable", { exact: true }).waitFor();
        assert.equal(await marker.locator("p").count(), state === "restarted" ? 1 : 0);
      }
      await page.goto(`${server.resolvedUrls!.local[0]}stopped-history-test?locale=${locale}&state=completed`);
      await page.getByText("Partial answer remains readable", { exact: true }).waitFor();
      assert.equal(await page.locator('.step-item[data-status="cancelled"]').count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    });
  } finally {
    await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true });
  }
});
