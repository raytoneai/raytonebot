import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Route } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { createPiHttpHost } from "../pi/piHost.ts";
import { piRuntimePlugin } from "../pi/piVitePlugin.ts";
import { authenticatedFetch } from "../pi/controlPlaneTestSupport.ts";
import { project } from "../exported-project.ts";
import { providerCatalog } from "../schema/agentuxConfig.ts";

test("sending before settings load uses the host provider and model, including after a later configuration change", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-provider-selection-"));
  const prompted: { provider?: string; model?: string }[] = [];
  const host = createPiHttpHost({ cwd: dir, appRoot: process.cwd(), dataDir: join(dir, "data"), browser: false, routineClock: false,
    bridgeFactory: async () => {
      let current = { provider: "deepseek", model: "deepseek-flash" };
      return { configure: async value => { current = { provider: value.provider!, model: value.model! }; },
        state: async () => ({ ...current, models: [], tools: [] }),
        prompt: async () => { prompted.push({ ...current }); },
        subscribe: () => () => {}, newSession: async () => {}, abort: async () => {}, dispose() {} };
    },
  });
  const server = await createServer({ configFile: false, cacheDir: join(dir, "vite"),
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    plugins: [react(), piRuntimePlugin({ cwd: dir, createHost: () => host }), {
      name: "provider-selection-test-libs",
      resolveId(id) { return id.startsWith("virtual:sandbox-lib/") ? `\0${id}` : undefined; },
      load(id) { return id.startsWith("\0virtual:sandbox-lib/") ? "export const code=''; export const exports={};" : undefined; },
    }],
  });
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  try {
    await server.listen();
    const base = server.resolvedUrls!.local[0].replace(/\/$/, "");
    const request = await authenticatedFetch(host, base);
    const save = async (settings: typeof project.providers) => {
      const { revision } = await (await request(`${base}/__agentcanvas/pi/providers`)).json();
      const response = await request(`${base}/__agentcanvas/pi/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: settings, keys: {}, removeKeys: [], revision }) });
      assert.equal(response.status, 200);
    };
    for (const { connectionId: id } of providerCatalog) await t.test(id, async () => {
      const settings = structuredClone(project.providers);
      for (const connection of settings.connections) connection.baseUrl = "http://127.0.0.1:1/v1";
      settings.defaultProviderId = id;
      const selected = settings.connections.find(p => p.id === id)!;
      selected.enabled = true; selected.defaultModel = `chosen-${id}`; selected.models = [selected.defaultModel];
      await save(settings);
      const page = await browser.newPage({ locale: "zh-CN" });
      page.setDefaultTimeout(10_000);
      const held: Route[] = [];
      let loading = true;
      const start = prompted.length;
      try {
        await page.route("**/__agentcanvas/pi/providers", route => {
          if (loading && route.request().method() === "GET") held.push(route);
          else void route.continue();
        });
        await page.goto(`${base}/#control-plane=${host.controlPlaneAuth.issueEntry(base)}`, { waitUntil: "domcontentloaded" });
        await page.locator("textarea").fill("Provider selection regression");
        const response = page.waitForResponse(r => r.url().endsWith("/pi/prompt") && r.request().method() === "POST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        loading = false;
        await Promise.all(held.map(route => route.continue()));
        assert.equal((await response).status(), 200);
        await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
        assert.deepEqual(prompted[start], { provider: id, model: selected.defaultModel });
        // Another tab can change settings while this conversation remains open.
        selected.defaultModel = `updated-${id}`; selected.models.push(selected.defaultModel);
        await save(settings);
        await page.locator("textarea").fill("Use the latest configured model");
        const next = page.waitForResponse(r => r.url().endsWith("/pi/prompt") && r.request().method() === "POST");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        assert.equal((await next).status(), 200);
        await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
        assert.deepEqual(prompted[start + 1], { provider: id, model: selected.defaultModel });
      } finally { await page.close(); }
    });
    await t.test("a failed settings read preserves the draft and never runs the built-in default", async () => {
      const page = await browser.newPage({ locale: "zh-CN" });
      const count = prompted.length;
      try {
        await page.route("**/__agentcanvas/pi/providers", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Model settings unavailable" }) }));
        await page.goto(`${base}/#control-plane=${host.controlPlaneAuth.issueEntry(base)}`, { waitUntil: "domcontentloaded" });
        await page.locator("textarea").fill("Keep this draft");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByText("Model settings unavailable", { exact: false }).first().waitFor();
        assert.equal(prompted.length, count);
        assert.equal(await page.locator("textarea").inputValue(), "Keep this draft");
      } finally { await page.close(); }
    });
  } finally { await browser.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
