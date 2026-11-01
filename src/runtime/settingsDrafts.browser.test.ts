import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import type { MemoryState } from "../pi/memoryTypes.ts";
import type { SkillState } from "../pi/skillTypes.ts";

test("settings navigation preserves non-secret editor drafts", { skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000 }, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-settings-drafts-"));
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [{ name: "settings-drafts-test", configureServer(vite) {
      vite.middlewares.use("/settings-drafts-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/settings-drafts-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SettingsDialog } from '/src/components/settings/SettingsDialog.tsx';
          import { useMemories } from '/src/runtime/useMemories.ts';
          import { useSkills } from '/src/runtime/useSkills.ts';
          import { useVault } from '/src/runtime/useVault.ts';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { project } from '/src/exported-project.ts';
          import '/src/styles/app.css';
          import '/src/styles/agentmatrix.css';
          function Probe() {
            const [open, setOpen] = useState(true);
            const [scope, setScope] = useState();
            const memories = useMemories(open), skills = useSkills(open), vault = useVault(open);
            return h('main', null,
              h('button', { onClick: () => { setScope(undefined); setOpen(true); } }, 'Open settings'),
              h('button', { onClick: () => { setScope({ kind: 'bot', id: 'assistant' }); setOpen(true); } }, 'Open Bot memory'),
              h(SettingsDialog, { open, onOpenChange: setOpen, initialSection: 'memory', initialMemoryScope: scope,
                project, isRunning: false, sessionKeys: {}, onSessionKeyChange() {}, onUpdateProvider() {},
                onSetDefaultProvider() {}, onPermissionDefaultChange() {}, themePreset: 'soft-glass', onThemeChange() {},
                memories, skills, vault, memoryScopes: [{ scope: { kind: 'bot', id: 'assistant' }, label: 'Assistant' }] }));
          }
          createRoot(document.getElementById('root')).render(h(LocaleProvider, { initialLocale: 'en' }, h(Probe)));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const nav = (page: Page, name: string) => page.locator(".settings-rail").getByRole("button", { name, exact: true }).click();
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    for (const width of [1280, 390]) {
      const withPage = async (run: (page: Page, data: { memory: MemoryState; skills: SkillState; writes: { path: string; body: any }[]; conflict: boolean }) => Promise<void>) => {
        const page = await browser!.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
        page.setDefaultTimeout(5_000);
        page.setDefaultNavigationTimeout(30_000);
        const data = {
          memory: { enabled: true, memories: [{ id: "item", text: "Original", createdAt: 1, updatedAt: 1,
            evidence: { url: "https://example.com/original", checkedAt: "2026-10-30" } }] } as MemoryState,
          skills: { revision: 1, skills: [{ id: "skill_11111111-1111-1111-1111-111111111111", name: "Existing skill", description: "Existing use", instructions: "Existing instructions", enabled: true, updatedAt: 1 }] } as SkillState,
          writes: [] as { path: string; body: any }[], conflict: false,
        };
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        try {
          await page.clock.install();
          await page.route("**/__agentcanvas/pi/**", async route => {
            const path = new URL(route.request().url()).pathname.split("/pi/")[1];
            let body: unknown, status = 200;
            if (route.request().method() === "GET") body = path === "memories" ? data.memory : path === "skills" ? data.skills : { revision: 1, items: [] };
            else {
              const input = route.request().postDataJSON();
              data.writes.push({ path, body: input });
              if (path.startsWith("memories")) {
                const memory = data.memory.memories.find(item => path.endsWith(`/${item.id}`));
                const expectedSnapshot = input.expectedSnapshot;
                const currentSnapshot = memory ? { text: memory.text, scope: memory.scope ?? { kind: "global" }, evidence: memory.evidence ?? null } : undefined;
                if (memory && (input.expectedText !== memory.text || expectedSnapshot && JSON.stringify(expectedSnapshot) !== JSON.stringify(currentSnapshot))) { status = 409; body = { error: "Memory changed elsewhere" }; }
                else {
                  const { expectedText: _expectedText, expectedSnapshot: _expectedSnapshot, ...changes } = input;
                  const saved = { ...(memory ?? { id: "added", createdAt: 2 }), ...changes, updatedAt: 3 };
                  if (memory) Object.assign(memory, saved); else data.memory.memories.push(saved);
                  body = { memory: saved };
                }
              } else if (path === "skills") {
                if (data.conflict) { data.conflict = false; data.skills.revision++; status = 409; body = { error: "Skills changed elsewhere" }; }
                else {
                  const skill = data.skills.skills.find(item => item.id === input.input.id);
                  if (skill) Object.assign(skill, input.input); else data.skills.skills.push({ id: "added-skill", updatedAt: 2, ...input.input });
                  data.skills.revision++; body = data.skills;
                }
              } else { status = 400; body = { error: "Unexpected test mutation" }; }
            }
            await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
          });
          await page.goto(`${base}settings-drafts-test`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.getByRole("textbox", { name: "Add something to remember…", exact: true }).waitFor();
          await run(page, data);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      };

      await t.test(`${width}px: new and existing memory drafts survive section changes with their original save precondition`, () => withPage(async (page, data) => {
        const add = page.getByRole("textbox", { name: "Add something to remember…", exact: true });
        await add.fill("New memory draft");
        const details = page.locator("details").last();
        await details.locator("summary").click();
        await details.getByLabel("Source URL", { exact: true }).fill("https://example.com/new");
        await details.getByLabel("Recorded check date (optional)", { exact: true }).fill("2026-11-01");
        await nav(page, "Permissions"); await nav(page, "Memory");
        assert.equal(await add.inputValue(), "New memory draft");
        assert.equal(await details.getByLabel("Source URL", { exact: true }).inputValue(), "https://example.com/new");
        assert.equal(await details.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "2026-11-01");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.waitForFunction(() => !(document.querySelector('input[placeholder="Add something to remember…"]') as HTMLInputElement)?.value);
        assert.deepEqual(data.writes[0].body, { text: "New memory draft", scope: { kind: "global" }, evidence: { url: "https://example.com/new", checkedAt: "2026-11-01" } });

        const row = page.locator(".settings-memory-row").last();
        await row.getByRole("button", { name: "Edit", exact: true }).click();
        await row.getByRole("textbox", { name: "Edit", exact: true }).fill("Edited draft");
        await row.locator("summary").click();
        await row.getByLabel("Source URL", { exact: true }).fill("https://example.com/edited");
        await row.getByLabel("Recorded check date (optional)", { exact: true }).fill("2026-11-01");
        await nav(page, "Permissions");
        data.memory.memories[0].text = "Updated elsewhere";
        data.memory.memories[0].evidence = { url: "https://example.com/concurrent", checkedAt: "2026-11-02" };
        const refreshed = page.waitForResponse(response => response.url().endsWith("/memories"));
        await page.clock.fastForward(5_000); await refreshed;
        await nav(page, "Memory");
        assert.equal(await row.getByRole("textbox", { name: "Edit", exact: true }).inputValue(), "Edited draft");
        assert.equal(await row.getByLabel("Recorded check date (optional)", { exact: true }).inputValue(), "2026-11-01");
        if (process.env.RAYTONEBOT_SETTINGS_DRAFT_SCREENSHOTS) await page.screenshot({ path: join(process.env.RAYTONEBOT_SETTINGS_DRAFT_SCREENSHOTS, `memory-draft-${width}.png`) });
        await row.getByRole("button", { name: "Save", exact: true }).click();
        await row.getByRole("status").waitFor();
        assert.deepEqual(data.writes.at(-1)?.body, { text: "Edited draft", expectedText: "Original",
          expectedSnapshot: { text: "Original", scope: { kind: "global" }, evidence: { url: "https://example.com/original", checkedAt: "2026-10-30" } },
          evidence: { url: "https://example.com/edited", checkedAt: "2026-11-01" } });
        assert.equal(await row.getByRole("textbox", { name: "Edit", exact: true }).inputValue(), "Edited draft");
        await row.getByRole("button", { name: "Cancel", exact: true }).click();
        await row.getByRole("button", { name: "Edit", exact: true }).click();
        assert.equal(await row.getByRole("textbox", { name: "Edit", exact: true }).inputValue(), "Updated elsewhere");
      }));

      await t.test(`${width}px: Skill creation, edits, conflicts and cancel keep the intended draft across navigation`, () => withPage(async (page, data) => {
        await nav(page, "MCP & Skills");
        await page.getByRole("button", { name: "Add Skill", exact: true }).click();
        const editor = page.locator(".settings-skills").getByRole("group");
        await editor.getByRole("textbox", { name: "Name", exact: true }).fill("New skill draft");
        await editor.getByRole("textbox", { name: "When to use", exact: true }).fill("Draft use");
        await editor.getByRole("textbox", { name: "Instructions", exact: true }).fill("Draft instructions");
        await nav(page, "Memory"); await nav(page, "MCP & Skills");
        assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "New skill draft");
        assert.equal(await editor.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(), "Draft instructions");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await editor.waitFor({ state: "detached" });
        assert.equal(data.writes.at(-1)?.body.input.description, "Draft use");
        const existing = page.locator(".settings-skills .settings-provider").filter({ hasText: "Existing skill" });
        await existing.getByRole("button", { name: "Edit", exact: true }).click();
        await editor.getByRole("textbox", { name: "Instructions", exact: true }).fill("Changed instructions");
        data.conflict = true;
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await editor.getByRole("alert").waitFor();
        await nav(page, "Permissions"); await nav(page, "MCP & Skills");
        assert.equal(await editor.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(), "Changed instructions");
        if (process.env.RAYTONEBOT_SETTINGS_DRAFT_SCREENSHOTS) await page.screenshot({ path: join(process.env.RAYTONEBOT_SETTINGS_DRAFT_SCREENSHOTS, `skill-draft-${width}.png`) });
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await editor.waitFor({ state: "detached" });
        assert.equal(data.writes.at(-1)?.body.revision, 3);
        assert.equal(data.skills.skills[0].instructions, "Changed instructions");
        await existing.getByRole("button", { name: "Edit", exact: true }).click();
        await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Discarded name");
        await nav(page, "Memory"); await nav(page, "MCP & Skills");
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await existing.getByRole("button", { name: "Edit", exact: true }).click();
        assert.equal(await editor.getByRole("textbox", { name: "Name", exact: true }).inputValue(), "Existing skill");
      }));

      await t.test(`${width}px: hidden editors stay out of keyboard navigation; Vault and dialog close still clear inputs`, () => withPage(async (page, data) => {
        await page.getByRole("textbox", { name: "Add something to remember…", exact: true }).fill("Close clears this draft");
        await nav(page, "MCP & Skills");
        await page.getByRole("button", { name: "Add Skill", exact: true }).click();
        await page.getByRole("textbox", { name: "Name", exact: true }).fill("Hidden skill draft");
        await nav(page, "Permissions");
        for (let n = 0; n < 18; n++) {
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[hidden]'))), false);
        }
        assert.equal(await page.getByRole("textbox").count(), 0, "hidden editors are absent from the accessibility tree");
        await nav(page, "Saved logins");
        await page.getByRole("button", { name: "Add login", exact: true }).click();
        await page.getByLabel("Username", { exact: true }).fill("dummy-user");
        await page.getByLabel("Password", { exact: true }).fill("dummy-password");
        await nav(page, "Memory"); await nav(page, "Saved logins");
        assert.equal(await page.getByLabel("Password", { exact: true }).count(), 0);
        await page.getByRole("button", { name: "Add login", exact: true }).click();
        assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
        assert.equal(await page.getByLabel("Username", { exact: true }).inputValue(), "");
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Open Bot memory", exact: true }).click();
        const add = page.getByRole("textbox", { name: "Add something to remember…", exact: true });
        assert.equal(await add.inputValue(), "");
        assert.equal(await page.locator(".settings-memory-row").count(), 0, "reopening a Bot scope filters out global memories");
        await add.fill("Bot memory");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.getByText("Bot memory", { exact: true }).waitFor();
        assert.deepEqual(data.writes.at(-1)?.body.scope, { kind: "bot", id: "assistant" });
        await nav(page, "MCP & Skills");
        assert.equal(await page.locator(".settings-skills").getByRole("group").count(), 0, "closing the dialog still discards its non-secret local editors");
      }));
    }
  } finally {
    await browser?.close(); await server.close(); rmSync(cacheDir, { recursive: true, force: true });
  }
});
