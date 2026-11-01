import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page, type Route } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

test("settings keep current results when reads and mutations overlap", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000 }, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-settings-test-"));
  const server = await createServer({ configFile: false, cacheDir, server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "settings-test-page", configureServer(vite) {
      vite.middlewares.use("/settings-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/settings-test", `<div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useMemories } from '/src/runtime/useMemories.ts';
          import { useMcpServers } from '/src/runtime/useMcpServers.ts';
          import { useImChannels } from '/src/runtime/useImChannels.ts';
          import { useLearning } from '/src/runtime/useLearning.ts';
          import { useRoutines } from '/src/runtime/useRoutines.ts';
          import { MemorySection } from '/src/components/settings/MemorySection.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { settingsCopy } from '/src/i18n/copy/settings.ts';
          const kind = new URLSearchParams(location.search).get('kind') || 'memory';
          const memory = kind === 'memory' || kind === 'memory-editor';
          function Probe() {
            const [active, setActive] = useState(true);
            const state = memory ? useMemories(active) : kind === 'mcp' ? useMcpServers(active) : kind === 'im' ? useImChannels(active, undefined) : kind === 'routines' ? useRoutines(active) : useLearning(active);
            if (kind === 'memory-editor') return h(LocaleProvider, { initialLocale: 'en' }, h(MemorySection, { t: settingsCopy.en, state }));
            const save = () => kind === 'routines' ? void state.update('item', { title: 'Updated', revision: 1 }) : kind === 'im' ? void state.save('telegram', { enabled: true }) : kind === 'learning' && state.state ? void state.update({ action: 'settings', revision: state.state.revision, enabled: true, reuse: false, dailyLimit: 1 }) : void state.save('item', memory ? 'Updated' : { name: 'Updated' });
            return h('main', null,
              h('button', { onClick: () => setActive(value => !value) }, active ? 'Close' : 'Open'),
              kind === 'learning' ? h('button', { onClick: () => void state.refresh() }, 'Reload') : null,
              h('button', { onClick: () => void state.remove('item') }, 'Delete'),
              h('button', { onClick: save }, 'Save'),
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
    const channelBody = (botName: string) => ({ channels: [{ platform: "telegram", enabled: true, fields: { botToken: "" }, secretsSet: { botToken: true }, access: "allowlist", allowUsers: [], agentPreset: "assistant", status: { state: "connected", botName }, denied: [] }] });
    const learningBody = (revision: number, lastResult: string) => ({ revision, enabled: revision > 1, reuse: false, dailyLimit: 1, day: "2026-11-01", calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, candidates: [], lastResult, queued: 0, running: false });
    const hookPage = async (kind: "im" | "learning" | "memory-editor" | "routines", run: (page: Page, take: (method: string) => Promise<Route>, respond: (route: Route, body: unknown, status?: number) => Promise<void>, requests: Route[]) => Promise<void>) => {
      const page = await browser!.newPage();
      const requests: Route[] = [];
      const take = async (method: string) => {
        const deadline = Date.now() + 3000;
        while (!requests.some(route => route.request().method() === method) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        const index = requests.findIndex(route => route.request().method() === method);
        const route = index < 0 ? undefined : requests.splice(index, 1)[0];
        assert.ok(route, `expected ${method} request`);
        return route;
      };
      const respond = async (route: Route, body: unknown, status = 200) => { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); };
      try {
        await page.clock.install();
        await page.route("**/__agentcanvas/pi/**", route => { requests.push(route); });
        await page.goto(`${base}settings-test?kind=${kind}`);
        await run(page, take, respond, requests);
      } finally { await page.close(); }
    };
    const routineBody = (title: string) => ({ routines: [{ id: "item", title }] });
    const wakeRoutines = (page: Page) => page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await t.test("routines: repeated slow reads can finish without timer or focus refreshes invalidating them", async () => {
      await hookPage("routines", async (page, take, respond, requests) => {
        for (const title of ["first", "second", "third"]) {
          const slow = await take("GET");
          await page.clock.fastForward(3100);
          await wakeRoutines(page);
          await page.waitForTimeout(30);
          assert.equal(requests.length, 0, "timer, focus and visibility refreshes must share the in-flight read");
          await respond(slow, routineBody(title));
          await page.waitForFunction(title => JSON.parse(document.querySelector("#state")!.textContent!).routines?.[0].title === title, title);
          if (title !== "third") await page.clock.fastForward(3000);
        }
      });
    });
    for (const lateFailure of [false, true]) {
      await t.test(`routines: saving excludes polling and stale ${lateFailure ? "errors" : "reads"} cannot release a newer read`, async () => {
        await hookPage("routines", async (page, take, respond, requests) => {
          await respond(await take("GET"), routineBody("old"));
          await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).routines?.[0].title === "old");
          await page.clock.fastForward(3000);
          const stale = await take("GET");
          await page.getByRole("button", { name: "Save", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
          const write = await take("POST");
          await page.clock.fastForward(6000);
          await wakeRoutines(page);
          await page.waitForTimeout(30);
          assert.equal(requests.length, 0, "one mutation owns the refresh until it settles");
          await respond(write, {});
          await respond(await take("GET"), routineBody("saved"));
          await page.waitForFunction(() => {
            const state = JSON.parse(document.querySelector("#state")!.textContent!);
            return !state.busy && state.routines?.[0].title === "saved";
          });
          await page.clock.fastForward(3000);
          const latest = await take("GET");
          await respond(stale, lateFailure ? { error: "Stale failure" } : routineBody("stale"), lateFailure ? 503 : 200);
          await wakeRoutines(page);
          await page.clock.fastForward(3000);
          await page.waitForTimeout(30);
          assert.equal(requests.length, 0, "the stale request's finally must not unlock the latest read");
          const state = JSON.parse((await page.locator("#state").textContent())!);
          assert.equal(state.routines[0].title, "saved");
          assert.equal(state.error, undefined);
          await respond(latest, routineBody("current"));
          await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).routines?.[0].title === "current");
        });
      });
    }
    await t.test("routines: conflicts refresh current data and reopening drops the previous read", async () => {
      await hookPage("routines", async (page, take, respond, requests) => {
        await respond(await take("GET"), routineBody("initial"));
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await respond(await take("POST"), { error: "Routine changed elsewhere" }, 409);
        await respond(await take("GET"), routineBody("conflict current"));
        await page.waitForFunction(() => {
          const state = JSON.parse(document.querySelector("#state")!.textContent!);
          return !state.busy && state.actionError?.message === "Routine changed elsewhere" && state.routines?.[0].title === "conflict current";
        });
        await page.clock.fastForward(3000);
        const oldVisit = await take("GET");
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page.clock.fastForward(6000);
        await wakeRoutines(page);
        await page.waitForTimeout(30);
        assert.equal(requests.length, 0, "closed settings do not poll");
        await page.getByRole("button", { name: "Open", exact: true }).click();
        const reopened = await take("GET");
        await respond(oldVisit, routineBody("closed visit"));
        await wakeRoutines(page);
        await page.waitForTimeout(30);
        assert.equal(requests.length, 0, "the old visit cannot unlock the reopened read");
        await respond(reopened, routineBody("reopened"));
        await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).routines?.[0].title === "reopened");
      });
    });
    await t.test("memory edit keeps its original precondition and draft across polls and stale saves", async () => {
      await hookPage("memory-editor", async (page, take, respond) => {
        const item = { id: "item", text: "Original", createdAt: 1, updatedAt: 1,
          evidence: { url: "https://example.com/source", checkedAt: "2026-10-30" } };
        const body = (value = item) => ({ enabled: true, memories: [value] });
        await respond(await take("GET"), body());
        const row = page.locator(".settings-memory-row");
        const source = row.getByRole("link", { name: /Source.*example.com/ });
        assert.equal(await source.getAttribute("href"), item.evidence.url);
        assert.match(await source.getAttribute("rel") ?? "", /noopener/);
        assert.match(await row.textContent() ?? "", /Recorded check date: 2026-10-30/);
        await row.getByRole("button", { name: "Edit", exact: true }).click();
        await row.getByRole("textbox", { name: "Edit", exact: true }).fill("My draft");
        await row.getByText("Source details (optional)", { exact: true }).click();
        assert.equal(await row.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "2026-10-30", "editing memory text preserves the source's recorded date");
        await row.getByLabel("Source URL", { exact: true }).fill(item.evidence.url);
        assert.equal(await row.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "2026-10-30");
        await row.getByLabel("Source URL", { exact: true }).fill("https://example.com/edited");
        assert.equal(await row.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "", "a new source must not inherit the previous source's date");
        await page.clock.fastForward(5000);
        const newer = { ...item, evidence: { url: "https://example.com/newer", checkedAt: "2026-10-31" }, updatedAt: 1 };
        await respond(await take("GET"), body(newer));
        await row.getByRole("button", { name: "Save", exact: true }).click();
        const staleWrite = await take("POST");
        assert.deepEqual(staleWrite.request().postDataJSON(), { text: "My draft", expectedText: "Original", expectedSnapshot: { text: "Original", scope: { kind: "global" }, evidence: item.evidence },
          evidence: { url: "https://example.com/edited" } });
        await respond(staleWrite, { error: "Memory changed. Review the current text." }, 409);
        await row.getByRole("status").waitFor();
        assert.equal(await row.getByRole("textbox", { name: "Edit", exact: true }).inputValue(), "My draft");
        assert.equal(await row.getByLabel("Source URL", { exact: true }).inputValue(), "https://example.com/edited");
        assert.equal(await row.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "", "the unsaved source date remains part of the draft after conflict");
        await row.getByRole("button", { name: "Cancel", exact: true }).click();
        await row.getByRole("button", { name: "Edit", exact: true }).click();
        assert.equal(await row.getByRole("textbox", { name: "Edit", exact: true }).inputValue(), newer.text);
        await row.getByText("Source details (optional)", { exact: true }).click();
        await row.getByLabel("Source URL", { exact: true }).fill("");
        await row.getByRole("button", { name: "Save", exact: true }).click();
        const clear = await take("POST");
        assert.deepEqual(clear.request().postDataJSON(), { text: newer.text, evidence: null, expectedText: newer.text, expectedSnapshot: { text: newer.text, scope: { kind: "global" }, evidence: newer.evidence } });
        await respond(clear, { memory: newer });
        await respond(await take("GET"), body({ ...newer, evidence: { url: "javascript:alert(1)", checkedAt: "2026-10-30" } }));
        await row.getByRole("button", { name: "Edit", exact: true }).waitFor();
        assert.equal(await row.getByRole("link").count(), 0, "unsafe source schemes are never rendered as links");
        await page.getByRole("textbox", { name: "Add something to remember…", exact: true }).fill("New fact");
        const addDetails = page.locator("details").last();
        await addDetails.locator("summary").click();
        assert.equal(await addDetails.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "");
        await addDetails.getByLabel("Source URL", { exact: true }).fill("https://example.com/draft-source");
        await addDetails.getByLabel("Recorded check date (optional)", { exact: true }).fill("2026-10-30");
        await addDetails.getByLabel("Source URL", { exact: true }).fill("https://example.com/new");
        assert.equal(await addDetails.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        const add = await take("POST");
        assert.deepEqual(add.request().postDataJSON(), { text: "New fact", scope: { kind: "global" }, evidence: { url: "https://example.com/new" } });
        await respond(add, { memory: { ...item, id: "added", text: "New fact" } });
        await respond(await take("GET"), body(newer));
        await page.waitForFunction(() => !(document.querySelector('input[placeholder="Add something to remember…"]') as HTMLInputElement)?.value);
        assert.equal(await addDetails.getByLabel("Source URL", { exact: true }).inputValue(), "");
        assert.equal(await addDetails.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "");
      });
    });
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
    for (const lateFailure of [false, true]) {
      await t.test(`IM: a slow poll cannot overlap or undo a save (${lateFailure ? "error" : "success"})`, async () => {
        await hookPage("im", async (page, take, respond, requests) => {
          await respond(await take("GET"), channelBody("old"));
          await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"botName":"old"'));
          await page.clock.fastForward(3000);
          const stale = await take("GET");
          await page.clock.fastForward(3000);
          await page.waitForTimeout(50);
          assert.equal(requests.length, 0, "polls do not overlap while a read is pending");
          await page.getByRole("button", { name: "Save", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
          const write = await take("POST");
          await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).saving === "telegram");
          assert.equal(requests.length, 0, "a same-tick double save sends one mutation");
          await respond(write, channelBody("new"));
          await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"botName":"new"'));
          await respond(stale, lateFailure ? { error: "Stale failure" } : channelBody("old"), lateFailure ? 503 : 200);
          await page.waitForTimeout(50);
          const state = JSON.parse((await page.locator("#state").textContent())!);
          assert.equal(state.channels[0].status.botName, "new");
          assert.equal(state.error, undefined);
        });
      });
    }
    await t.test("Learning: generation rejects stale reads while revision protection remains", async () => {
      await hookPage("learning", async (page, take, respond, requests) => {
        const initial = await take("GET");
        await page.getByRole("button", { name: "Reload", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
        await page.waitForTimeout(50);
        assert.equal(requests.length, 0, "reload does not overlap the pending initial read");
        await respond(initial, learningBody(1, "old"));
        await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).state?.revision === 1);
        await page.clock.fastForward(5000);
        const staleSuccess = await take("GET");
        await page.clock.fastForward(5000);
        await page.waitForTimeout(50);
        assert.equal(requests.length, 0, "learning polls do not overlap while a read is pending");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const firstWrite = await take("POST");
        await respond(firstWrite, learningBody(2, "saved"));
        await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).state?.revision === 2);
        await respond(staleSuccess, learningBody(1, "stale success"));
        await page.waitForTimeout(50);
        assert.equal(JSON.parse((await page.locator("#state").textContent())!).state.revision, 2);

        await page.clock.fastForward(5000);
        const staleFailure = await take("GET");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const secondWrite = await take("POST");
        await respond(secondWrite, learningBody(3, "saved again"));
        await page.waitForFunction(() => JSON.parse(document.querySelector("#state")!.textContent!).state?.revision === 3);
        await respond(staleFailure, { error: "Stale failure" }, 503);
        await page.waitForTimeout(50);
        const state = JSON.parse((await page.locator("#state").textContent())!);
        assert.equal(state.state.revision, 3);
        assert.equal(state.error, undefined, "a stale poll failure cannot replace a saved state");
        assert.equal(requests.length, 0);
      });
    });
    for (const kind of ["im", "learning"] as const) {
      await t.test(`${kind}: an active switch drops the previous read`, async () => {
        await hookPage(kind, async (page, take, respond) => {
          await respond(await take("GET"), kind === "im" ? channelBody("old") : learningBody(1, "old"));
          await page.clock.fastForward(kind === "im" ? 3000 : 5000);
          const stale = await take("GET");
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await page.getByRole("button", { name: "Open", exact: true }).click();
          const fresh = await take("GET");
          await respond(fresh, kind === "im" ? channelBody("new") : learningBody(2, "new"));
          await respond(stale, kind === "im" ? channelBody("old") : learningBody(1, "old"));
          await page.waitForFunction(() => document.querySelector("#state")?.textContent?.includes('"new"'));
          await page.waitForTimeout(20);
          const state = JSON.parse((await page.locator("#state").textContent())!);
          assert.match(JSON.stringify(state), /new/);
        });
      });
    }
  } finally {
    await browser?.close(); await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
