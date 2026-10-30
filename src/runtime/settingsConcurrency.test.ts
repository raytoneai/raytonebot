import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Route } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("settings keep current results when reads and mutations overlap", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 30_000 }, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-settings-test-"));
  const server = await createServer({ configFile: false, cacheDir, server: { host: "127.0.0.1", port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client"] },
    plugins: [{ name: "settings-test-page", configureServer(vite) {
      vite.middlewares.use("/settings-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/settings-test", `<div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useMemories } from '/src/runtime/useMemories.ts';
          import { useMcpServers } from '/src/runtime/useMcpServers.ts';
          const memory = new URLSearchParams(location.search).get('kind') === 'memory';
          function Probe() {
            const [active, setActive] = useState(true);
            const state = (memory ? useMemories : useMcpServers)(active);
            return h('main', null,
              h('button', { onClick: () => setActive(value => !value) }, active ? 'Close' : 'Open'),
              h('button', { onClick: () => void state.remove('item') }, 'Delete'),
              h('button', { onClick: () => void state.save('item', memory ? 'Updated' : { name: 'Updated' }) }, 'Save'),
              h('pre', { id: 'state' }, JSON.stringify(state)));
          }
          createRoot(document.getElementById('root')).render(h(Probe));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    for (const kind of ["memory", "mcp"] as const) {
      for (const lateFailure of [false, true]) {
        await t.test(`${kind}: a late ${lateFailure ? "error" : "read"} cannot undo deletion`, async () => {
          const page = await browser!.newPage();
          const requests: Route[] = [];
          const readBody = (items: unknown[]) => kind === "memory" ? { enabled: true, memories: items } : { servers: items };
          const initial = readBody([{ id: "item", text: "Old", name: "Old" }]);
          const request = async (method: string) => {
            const deadline = Date.now() + 3000;
            while (!requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            const route = requests.shift();
            assert.ok(route, `expected ${method} request`);
            assert.equal(route.request().method(), method);
            return route;
          };
          const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
          try {
            if (kind === "memory") await page.clock.install();
            await page.route("**/__agentcanvas/pi/**", route => { requests.push(route); });
            await page.goto(`${base}settings-test?kind=${kind}`);
            await respond(await request("GET"), initial);
            await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"Old"'));
            // Memories poll; MCP reloads on reopen while keeping the current list visible.
            if (kind === "memory") await page.clock.fastForward(5000);
            else {
              await page.getByRole("button", { name: "Close", exact: true }).click();
              await page.getByRole("button", { name: "Open", exact: true }).click();
            }
            const stale = await request("GET");
            if (kind === "memory") {
              await page.clock.fastForward(5000);
              await page.waitForTimeout(50);
              assert.equal(requests.length, 0, "a slow poll is allowed to finish before another poll starts");
            }
            await page.getByRole("button", { name: "Delete", exact: true }).click();
            await respond(await request("DELETE"), {});
            await respond(await request("GET"), readBody([]));
            await page.waitForFunction(() => {
              const value = JSON.parse(document.querySelector("#state")!.textContent!);
              return !value.busy && (value.memory?.memories ?? value.servers)?.length === 0;
            });
            await respond(stale, lateFailure ? { error: "Stale failure" } : initial, lateFailure ? 503 : 200);
            await page.waitForLoadState("networkidle");
            const state = JSON.parse((await page.locator("#state").textContent())!);
            assert.deepEqual(state.memory?.memories ?? state.servers, []);
            assert.equal(state.error, undefined);

            // A second action cannot slip through before React commits the busy state.
            await page.getByRole("button", { name: "Save", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
            const write = await request("POST");
            await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).busy === "item");
            await respond(write, {});
            await respond(await request("GET"), readBody([]));
            await page.waitForLoadState("networkidle");
            assert.equal(requests.length, 0, "only one mutation and its refresh are sent");
            assert.equal(JSON.parse((await page.locator("#state").textContent())!).busy, undefined);

            await page.getByRole("button", { name: "Save", exact: true }).click();
            await respond(await request("POST"), { error: "Save failed" }, 503);
            await page.waitForFunction(() => {
              const value = JSON.parse(document.querySelector("#state")!.textContent!);
              return !value.busy && value.actionError?.message === "Save failed";
            });
            await page.getByRole("button", { name: "Save", exact: true }).click();
            await respond(await request("POST"), {});
            await respond(await request("GET"), readBody([]));
            await page.waitForFunction(() => {
              const value = JSON.parse(document.querySelector("#state")!.textContent!);
              return !value.busy && !value.actionError;
            });
          } finally { await page.close(); }
        });
      }
    }
  } finally {
    await browser?.close(); await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
