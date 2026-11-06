import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";

const html = `<h1>Keyboard preview</h1><label>Name <input id="name"></label><label>Choice <select id="choice"><option>A</option><option>B</option></select></label><label>Notes <textarea id="notes"></textarea></label><button id="last">Finish</button>`;
const form = JSON.stringify({ kind: "raytone-form", version: 1, title: "Native form", prompt: "Use these values", fields: [
  { id: "name", label: "Native name", type: "text" }, { id: "choice", label: "Native choice", type: "select", options: ["A", "B"] },
] });

test("expanded Output keeps keyboard access to sandbox HTML and native forms", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000,
}, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-output-keyboard-"));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [react(), {
      name: "output-keyboard-libs",
      resolveId(id) { return id.startsWith("virtual:sandbox-lib/") ? `\0${id}` : undefined; },
      load(id) { return id.startsWith("\0virtual:sandbox-lib/") ? "export const code=''; export const exports={};" : undefined; },
    }, { name: "output-keyboard-page", configureServer(vite) {
      vite.middlewares.use("/output-keyboard-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/output-keyboard-test", `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>
          <script type="module">
            import { createElement as h, useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import { AnimatePresence } from 'motion/react';
            import { OutputFrame } from '/src/components/agent-preview/OutputFrame.tsx';
            import { ShellExtrasProvider } from '/src/components/shell/ShellExtras.tsx';
            import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
            import { project } from '/src/exported-project.ts';
            import { useConversationNavigation } from '/src/runtime/useConversationNavigation.ts';
            import '/src/styles/app.css';
            import '/src/styles/agentmatrix.css';
            const fullscreen = new URLSearchParams(location.search).has('fullscreen');
            const navigation = new URLSearchParams(location.search).has('navigation');
            const config = { ...project, output: { ...project.output, source: 'workspace' } };
            function Probe() {
              const [open, setOpen] = useState(!fullscreen);
              const nav = useConversationNavigation('group_fixture', 'assistant', true);
              return h(ShellExtrasProvider, { value: { workspaceScope: 'assistant', workspaceBotName: 'Assistant', workspaceSharedAvailable: false,
                ...(navigation ? {navigation:{...nav, activeBotId:'assistant',activeSessionId:'group_fixture',groupActive:true,
                  sessions:[{id:'group_fixture',title:'Group chat fixture',groupMembers:['assistant','planner']}],
                  onSelect:()=>setOpen(false),onNew(){},onNewGroup(){},openHistory:()=>setOpen(true)},
                  panelProfile:h('div',null,'Group members'),outputPanel:{source:'history',select(){},browserAvailable:false}} : {})} },
                h('main', { className: 'preview-frame', style: { height: '100vh', display: navigation ? 'flex' : 'block' } },
                  h('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open output'),
                  h(AnimatePresence, null, open ? h(OutputFrame, { project: config, viewModel: { timeline: [] }, fullscreen,
                    onSourceChange() {}, onCollapse: () => setOpen(false) }) : null),
                  h('button', { id: 'background', onClick: () => setOpen(false) }, 'Background action')));
            }
            createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: 'en' }, h(Probe)));
          </script>`));
      });
    } }],
  });
  const browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
  const focused = (page: Page, selector: string) => page.locator(selector).evaluate(element => element === document.activeElement);
  try {
    await server.listen();
    const base = server.resolvedUrls!.local[0];
    for (const width of [1280, 390]) for (const fullscreen of [false, true]) {
      await t.test(`${width}px ${fullscreen ? "fullscreen" : "expanded"}: iframe at the final tab position and dynamic native controls`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
        page.setDefaultTimeout(5_000);
        page.setDefaultNavigationTimeout(30_000);
        try {
          await page.route("**/__agentcanvas/pi/**", async route => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("/files/download")) return route.fulfill({ contentType: "text/plain", body: url.searchParams.get("path") === "form.json" ? form : html });
            if (url.pathname.endsWith("/files")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ files: ["preview.html", "form.json"].map(name => ({ name, path: name, size: 200, directory: false })) }) });
            await route.fulfill({ contentType: "application/json", body: "{}" });
          });
          await page.goto(`${base}output-keyboard-test${fullscreen ? "?fullscreen" : ""}`, { waitUntil: "domcontentloaded" });
          if (fullscreen) await page.getByRole("button", { name: "Open output", exact: true }).click();
          else await page.getByRole("button", { name: "Expand output", exact: true }).click();
          const panel = page.locator('.artifact-frame[data-expanded="true"]');
          await panel.waitFor();
          await panel.getByRole("button", { name: "preview.html", exact: false }).click();
          const frame = page.frameLocator('iframe[title="preview.html"]');
          await frame.locator("#name").waitFor();
          assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
          assert.equal(await page.locator("iframe").evaluate((element: HTMLIFrameElement) => element.contentDocument), null, "the HTML remains an opaque-origin frame");
          await panel.getByRole("button", { name: "Reload preview", exact: true }).focus();
          await page.keyboard.press("Tab");
          assert.equal(await frame.locator("#name").evaluate(element => element === document.activeElement), true, "Tab after Reload enters the HTML instead of wrapping to the header");
          for (const id of ["choice", "notes", "last"]) {
            await page.keyboard.press("Tab");
            assert.equal(await frame.locator(`#${id}`).evaluate(element => element === document.activeElement), true);
          }
          if (process.env.RAYTONEBOT_OUTPUT_KEYBOARD_SCREENSHOTS) await page.screenshot({ path: join(process.env.RAYTONEBOT_OUTPUT_KEYBOARD_SCREENSHOTS, `output-keyboard-${width}-${fullscreen ? "fullscreen" : "expanded"}.png`) });
          await page.keyboard.press("Tab");
          assert.equal(await focused(page, '.output-source-switch button:first-child'), true, "leaving the iframe wraps inside Output");
          await page.keyboard.press("Shift+Tab");
          assert.equal(await focused(page, "iframe"), true, "reverse wrapping reaches the opaque frame");
          // Focusing an opaque iframe cannot select its inner last node; native reverse traversal can.
          if (!await frame.locator("#last").evaluate(element => element === document.activeElement)) await page.keyboard.press("Shift+Tab");
          assert.equal(await frame.locator("#last").evaluate(element => element === document.activeElement), true);
          await page.keyboard.press("Shift+Tab");
          assert.equal(await frame.locator("#notes").evaluate(element => element === document.activeElement), true);
          await panel.locator(".workspace-preview-back").click();
          await panel.getByRole("button", { name: "form.json", exact: false }).click();
          await panel.getByLabel("Native name", { exact: true }).waitFor();
          await panel.evaluate(element => {
            const hidden = document.createElement("button"); hidden.hidden = true; hidden.textContent = "Hidden";
            element.prepend(hidden);
            const ignored = document.createElement("div");
            ignored.innerHTML = '<div inert><button>Inert</button></div><fieldset disabled><input></fieldset><button tabindex="-1">Negative tabindex</button>';
            element.insertBefore(ignored, element.lastElementChild);
          });
          await panel.getByRole("button", { name: "Reload preview", exact: true }).focus();
          await page.keyboard.press("Tab");
          assert.equal(await panel.getByLabel("Native name", { exact: true }).evaluate(element => element === document.activeElement), true);
          await page.keyboard.press("Tab");
          assert.equal(await panel.locator(".structured-artifact select").evaluate(element => element === document.activeElement), true);
          assert.equal(await panel.getByRole("button", { name: "Submit to conversation", exact: true }).isDisabled(), true);
          await page.keyboard.press("Tab");
          assert.equal(await focused(page, '.output-source-switch button:first-child'), true, "a disabled submit cannot let focus leave Output");
          await page.keyboard.press("Shift+Tab");
          assert.equal(await panel.locator(".structured-artifact select").evaluate(element => element === document.activeElement), true, "reverse wrapping includes native select controls and skips hidden, inert and disabled controls");
          await panel.locator(".workspace-preview-back").click();
          await panel.locator(".workspace-scope-select").click();
          await page.getByRole("menu").waitFor();
          await page.keyboard.press("Escape");
          await page.locator('[role="menu"]').waitFor({ state: "detached" });
          // Radix returns focus in a deferred unmount callback, after its menu DOM is removed.
          await page.waitForFunction(() => document.activeElement?.matches(".workspace-scope-select button"));
          assert.equal(await panel.count(), 1, "a nested menu owns its Escape");
          await panel.getByRole("button", { name: "Collapse output", exact: true }).focus();
          await page.keyboard.press("Escape");
          if (fullscreen) {
            await panel.waitFor({ state: "detached" });
            await page.waitForFunction(() => document.activeElement?.id === "opener");
            assert.equal(await focused(page, "#opener"), true);
          } else {
            await page.locator('.artifact-frame[data-expanded="false"]').waitFor();
            await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Expand output");
            assert.equal(await page.getByRole("button", { name: "Expand output", exact: true }).evaluate(element => element === document.activeElement), true);
          }
          await page.getByRole("button", { name: fullscreen ? "Open output" : "Expand output", exact: true }).click();
          await page.locator("#background").focus();
          await page.keyboard.press("Escape");
          assert.equal(await panel.count(), 1, "keys from outside Output cannot close it");
          await page.locator("#background").evaluate((element: HTMLButtonElement) => element.click());
          await panel.waitFor({ state: "detached" });
          assert.equal(await focused(page, "#background"), true, "a parent dismissal does not take focus away from the user's new target");
        } finally { await page.close(); }
      });
    }
    for (const width of [390, 660, 682, 860, 1280]) {
      await t.test(`${width}px navigation: group history opens inside the viewport and remains clickable`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 925 }, reducedMotion: "reduce" });
        page.setDefaultTimeout(5_000);
        try {
          await page.goto(`${base}output-keyboard-test?fullscreen&navigation`, { waitUntil: "domcontentloaded" });
          await page.getByRole("button", { name: "Open output", exact: true }).click();
          const panel = page.locator('.artifact-frame[data-expanded="true"]');
          await panel.waitFor();
          const bounds = await panel.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
          });
          assert.ok(bounds.width >= width * 0.6, `history must have usable width: ${JSON.stringify(bounds)}`);
          assert.ok(bounds.x >= -1 && bounds.right <= width + 1, `history must be on screen: ${JSON.stringify(bounds)}`);
          assert.ok(bounds.y >= -1 && bounds.bottom <= 926, `history must fit vertically: ${JSON.stringify(bounds)}`);
          const collapse = panel.getByRole("button", { name: "Collapse output", exact: true });
          assert.equal(await collapse.locator(".lucide-x").count(), 0, "the sidebar collapses instead of using a modal close glyph");
          assert.equal(await collapse.locator(".native-rail-icon svg rect").count(), 2, "the collapse glyph matches the sidebar entry");
          await collapse.click();
          await panel.waitFor({ state: "detached" });
          assert.equal(await focused(page, "#opener"), true, "clicking collapse returns focus to the entry");
          await page.getByRole("button", { name: "Open output", exact: true }).click();
          await panel.waitFor();
          await panel.getByRole("button", { name: /Group chat fixture/ }).click();
          await panel.waitFor({ state: "detached" });
          await page.getByRole("button", { name: "Open output", exact: true }).click();
          await panel.waitFor();
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached" });
          assert.equal(await focused(page, "#opener"), true);
        } finally { await page.close(); }
      });
    }
    await t.test("the mobile drawer slides in and can reopen while exiting", async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(`${base}output-keyboard-test?fullscreen&navigation`);
        const panel = page.locator(".artifact-frame[data-workspace-drawer]");
        await page.locator("#opener").click();
        await page.waitForFunction(() => {
          const x = document.querySelector(".artifact-frame[data-workspace-drawer]")?.getBoundingClientRect().x;
          return x !== undefined && x > 0 && x < 390;
        });
        await panel.getByRole("button", { name: "Collapse output" }).click();
        await page.waitForFunction(() => document.querySelector(".artifact-frame[data-workspace-drawer][inert]"));
        assert.equal(await focused(page, "#opener"), true);
        await page.keyboard.press("Enter");
        await panel.getByRole("button", { name: "Collapse output" }).waitFor();
        assert.equal(await panel.count(), 1);
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
      } finally { await page.close(); }
    });
  } finally { await browser.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true }); }
});
