import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("conversation run leases preserve stop, handoff, and replacement ownership", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000,
}, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-run-lease-test-"));
  const server = await createServer({
    root: process.cwd(), configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [react(), { name: "run-lease-test-page", configureServer(vite) {
      vite.middlewares.use("/run-lease", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/run-lease", `<div id="root"></div><script type="module">
          import { createElement as h, useRef } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useConversationRuns } from '/src/runtime/useConversationRuns.ts';
          import { createConversationStream } from '/src/runtime/conversationStream.ts';
          import { createEphemeralPiConversation } from '/src/pi/piConversationState.ts';
          function Probe() {
            const runs = useConversationRuns();
            const follow = useRef();
            return h('div', null, h('button', { id: 'exercise', onClick: async () => {
              const first = runs.acquire('c', { accepting: true });
              const duplicate = runs.acquire('c');
              first.finish();
              const replacement = runs.acquire('c', { accepting: true, preparing: true });
              const other = runs.acquire('other');
              replacement.bind('replacement-run');
              replacement.awaiting(true);
              first.accepted();
              first.awaiting(false);
              first.prepared();
              first.finish();
              await runs.stop('c');
              const initial = createEphemeralPiConversation('c');
              const started = { id: 'started', runId: 'replacement-run', type: 'run.started', payload: {} };
              const stream = createConversationStream({ ...initial, events: [started] }, {
                isCurrent: replacement.isCurrent,
                commit: snapshot => { window.committed = snapshot.events.map(event => event.type); },
              });
              stream.replace({ ...initial, events: [started,
                { id: 'cancelled', runId: 'replacement-run', type: 'run.finished', payload: { status: 'cancelled' } }] });
              replacement.finish({ handoff: true });
              follow.current = runs.acquire('c', { runId: 'replacement-run' });
              window.result = { first: !!first, duplicate: !!duplicate, replacement: !!replacement,
                other: !!other, abortedDuringPreparation: replacement.controller.signal.aborted,
                terminalCommitted: window.committed?.includes('run.finished') };
            } }, 'exercise'), h('button', { id: 'finish-follow', onClick: () => follow.current.finish() }, 'finish follow'),
            h('output', { id: 'state' }, [runs.acceptingIds.has('c'), runs.runningIds.has('c'),
              runs.awaitingIds.has('c'), runs.runningIds.has('other')].join(',')));
          }
          createRoot(document.getElementById('root')).render(h(Probe));
        </script>`));
      });
    } }], resolve: { dedupe: ["react", "react-dom"] },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls!.local[0]}run-lease`);
    await page.locator("#exercise").click();
    const result = await page.evaluate(() => (window as Window & { result?: Record<string, unknown> }).result);
    assert.deepEqual(result, { first: true, duplicate: false, replacement: true, other: true,
      abortedDuringPreparation: true, terminalCommitted: true });
    await page.locator("#state").getByText("true,true,true,true").waitFor();
    await page.locator("#finish-follow").click();
    await page.locator("#state").getByText("false,false,false,true").waitFor();
    await page.close();
  } finally {
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
