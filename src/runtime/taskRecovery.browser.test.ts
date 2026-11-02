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

// Actual host restart/native context persistence is covered by piHost.test.ts.
test("explicit restart recovery uses the real hook, ChatFrame and Composer in every locale", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 90_000,
}, async t => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-recovery-"));
  const adapter = createPiEventAdapter({ runId: "interrupted-run" });
  adapter.startUserMessage("Publish the approved report");
  adapter.apply({ type: "tool_execution_start", toolCallId: "publish", toolName: "mcp__publish", args: {} });
  const events = [...adapter.events, ...piCancelledTurnEvents(adapter.events, "host_restart")];
  const conversation = { id: "recovery-conversation", title: "Report", createdAt: 1, agentPreset: "pi", events, stored: true };
  const attachment = { kind: "file", path: "report.txt", name: "report.txt" };
  const saved = { ...conversation, updatedAt: 1, eventCount: events.length,
    turns: [{ runId: "interrupted-run", prompt: "Publish the approved report", attachments: [attachment], referencedConversationIds:["source-chat"] }] };
  const server = await createServer({ configFile: false, cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-markdown", "remark-gfm"] },
    plugins: [react(), { name: "task-recovery-test", configureServer(vite) {
      vite.middlewares.use("/recovery-test", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/recovery-test", `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
          import { createElement as h, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { createAgentUXViewModel } from '@agent-ux/render-core';
          import { ChatFrame } from '/src/components/agent-preview/ChatFrame.tsx';
          import { ComposerFrame } from '/src/components/agent-preview/ComposerFrame.tsx';
          import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
          import { IconSetProvider } from '/src/agentmatrix/IconSetContext.tsx';
          import { ShellExtrasProvider } from '/src/components/shell/ShellExtras.tsx';
          import { project } from '/src/exported-project.ts';
          import { useTaskRecovery } from '/src/runtime/useTaskRecovery.ts';
          import { cancelledTurnsForReplay } from '/src/runtime/cancelledTurns.ts';
          import { branchReplayEvents } from '/src/runtime/useMessageBranch.ts';
          import '/src/styles/app.css';
          const params = new URLSearchParams(location.search), locale = params.get('locale') || 'en';
          window.submits = []; window.configured = []; window.saved = ${JSON.stringify(saved)};
          window.current = true; window.reads = 0;
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => { if (!String(args[0]).includes('/conversations/recovery-conversation')) return originalFetch(...args); window.reads++; await new Promise(resolve => window.releaseRead ? window.releaseRead = resolve : setTimeout(resolve, 10));
            return new Response(JSON.stringify(window.saved), {status: 200, headers: {'content-type':'application/json'}}); };
          const base = ${JSON.stringify(conversation)};
          if (params.has('config')) {
            base.events = [{id:'config-error',runId:'interrupted-run',type:'run.error',payload:{message:'DeepSeek API key is not set.'},ts:1,seq:1}];
            window.saved.events = base.events;
          }
          function App() {
            const [conversation, setConversation] = useState(base), [running, setRunning] = useState(false);
            const [draft, setDraft] = useState({prompt:'Unrelated unsent draft', attachments:[]});
            window.setConversation = value => setConversation(value); window.setRunning = setRunning;
            const recovery = useTaskRecovery({ conversation, enabled:true, running, locale,
              submissions:new Map([['interrupted-run', {prompt:'Local fallback must not be used',attachments:[]}]]),
              isCurrent: () => window.current, configure: value => window.configured.push(value),
              submit: async (draft, target, requestId) => {window.submits.push({draft, target, requestId});} });
            window.resumeRecovery = recovery?.resume;
            const viewModel = createAgentUXViewModel(branchReplayEvents(cancelledTurnsForReplay(conversation.events, locale)));
            return h(ShellExtrasProvider, { value: {taskRecovery:recovery, composerDraft:{value:draft,onChange:setDraft}} },
              h(ChatFrame, { project, viewModel, previewPrompt:'' }),
              h(ComposerFrame, {project, modelOptions:[],onSubmit:()=>{},onProviderChange:()=>{},onModelChange:()=>{}}));
          }
          createRoot(document.getElementById('root')).render(h(IconSetProvider,null,h(LocaleProvider,{initialLocale:locale},h(App))));
        </script>`));
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const url = `${server.resolvedUrls!.local[0]}recovery-test`;
    for (const width of [1280, 390]) for (const [locale, label] of [
      ["en", "Check and continue"], ["zh", "核对并继续"], ["ja", "確認して続ける"],
    ]) await t.test(`${locale}, ${width}px explicit-only, refresh, submit and draft`, async () => {
      const page = await browser!.newPage({ viewport: { width: Number(width), height: 1000 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(5_000); page.setDefaultNavigationTimeout(30_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${url}?locale=${locale}`);
      const block = page.locator(".task-recovery");
      await block.getByRole("button", {name:label, exact:true}).waitFor();
      assert.equal(await block.getByRole("button").count(), 1);
      assert.equal(await page.evaluate(() => (window as any).submits.length), 0);
      assert.equal(await page.evaluate(() => (window as any).reads), 0);
      await page.reload();
      await block.getByRole("button", {name:label, exact:true}).waitFor();
      assert.match(await block.innerText(), /mcp__publish/);
      const screenshotDir = process.env.RAYTONEBOT_TEST_SCREENSHOT_DIR;
      if (screenshotDir) { mkdirSync(screenshotDir, {recursive:true}); await page.screenshot({path:join(screenshotDir,`${locale}-${width}-recovery.png`),fullPage:true}); }
      await block.getByRole("button").evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await page.waitForFunction(() => (window as any).submits.length === 1);
      const submission = await page.evaluate(() => (window as any).submits[0]);
      assert.equal(submission.target.id, conversation.id);
      assert.match(submission.requestId, /^continue_[a-f0-9]{64}$/);
      assert.notEqual(submission.requestId, "interrupted-run");
      assert.ok(submission.draft.prompt.endsWith("Publish the approved report"));
      assert.deepEqual(submission.draft.attachments.filter((file: any) => file.reference).map((file: any) => file.reference), [attachment]);
      assert.deepEqual(submission.draft.attachments.filter((file: any) => file.chatReference).map((file: any) => file.chatReference.conversationId), ["source-chat"]);
      assert.equal(await page.locator("textarea").inputValue(), "Unrelated unsent draft");
      assert.deepEqual(await page.evaluate(() => (window as any).configured), []);
      assert.deepEqual(errors, []);
      await page.close();
    });
    await t.test("configuration recovery still requires its configure step", async () => {
      const page = await browser!.newPage();
      await page.goto(`${url}?config=1`);
      const block = page.locator(".task-recovery");
      await block.getByRole("button", {name:"Check model service",exact:true}).waitFor();
      assert.equal(await block.getByRole("button", {name:"Continue task",exact:true}).count(), 0);
      await block.getByRole("button", {name:"Check model service",exact:true}).click();
      assert.deepEqual(await page.evaluate(() => (window as any).configured), ["providers"]);
      assert.equal(await page.evaluate(() => (window as any).submits.length), 0);
      await block.getByRole("button", {name:"Continue task",exact:true}).click();
      await page.waitForFunction(() => (window as any).submits.length === 1);
      assert.match(await page.evaluate(() => (window as any).submits[0].draft.prompt), /^Configuration has been checked/);
      await page.close();
    });
    await t.test("fresh host state, missing original and stale UI block submission", async () => {
      const page = await browser!.newPage(); page.setDefaultTimeout(5_000); page.setDefaultNavigationTimeout(30_000);
      for (const state of ["active", "running", "incomplete", "newer", "missing", "group", "observer"]) {
        await page.goto(url);
        await page.locator(".task-recovery button").waitFor();
        await page.evaluate(state => {
          const w = window as any;
          if (state === "active") w.saved.activeRunId = "another-run";
          if (state === "running") w.saved.running = true;
          if (state === "incomplete") w.saved.incomplete = true;
          if (state === "newer") w.saved.events.push({type:"run.finished",runId:"newer",id:"newer-end",payload:{status:"success"}});
          if (state === "missing") w.saved.turns = [];
          if (state === "group") w.saved.group = {members:["pi","codex"]};
          if (state === "observer") w.saved.systemRole = "observer";
        }, state);
        await page.locator(".task-recovery button").click();
        await page.locator('.task-recovery [role="status"]').waitFor();
        assert.equal(await page.evaluate(() => (window as any).submits.length), 0, state);
        assert.equal(await page.locator("textarea").inputValue(), "Unrelated unsent draft");
      }
      // Navigation or a new local run while the host read is pending invalidates the captured action.
      for (const state of ["navigation", "running", "new-target"]) {
        await page.goto(url); await page.locator(".task-recovery button").waitFor();
        await page.evaluate(() => { (window as any).releaseRead = true; });
        await page.locator(".task-recovery button").click();
        await page.waitForFunction(() => typeof (window as any).releaseRead === "function");
        await page.evaluate(state => {
          const w = window as any;
          if (state === "navigation") w.current = false;
          if (state === "running") w.setRunning(true);
          if (state === "new-target") w.setConversation({...w.saved, events:w.saved.events.map((e:any)=>({...e,runId:"another-interrupted"}))});
        }, state);
        // Allow the hook's refs to reflect the React update before resolving HTTP.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => (window as any).releaseRead());
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => (window as any).submits.length), 0, state);
      }
      await page.goto(url); await page.locator(".task-recovery button").waitFor();
      await page.evaluate(() => {
        const w=window as any; w.oldResume=w.resumeRecovery;
        w.setConversation({...w.saved, events:w.saved.events.map((e:any)=>({...e,runId:"another-interrupted"}))});
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => (window as any).oldResume());
      assert.equal(await page.evaluate(() => (window as any).reads), 0, "stale closure makes no host request");
      assert.equal(await page.evaluate(() => (window as any).submits.length), 0);
      // Defensive hook gating also holds outside the shell caller.
      for (const state of ["group", "observer"]) {
        await page.goto(url); await page.locator(".task-recovery button").waitFor();
        await page.evaluate(state => { const w=window as any; w.setConversation({...w.saved,...(state === "group" ? {groupMembers:["pi","codex"]}:{systemRole:"observer"})}); }, state);
        await page.locator(".task-recovery").waitFor({state:"detached"});
      }
      await page.close();
    });
    await t.test("separate tabs use one deterministic continuation identity", async () => {
      const ids: string[] = [];
      for (let i=0;i<2;i++) {
        const page = await browser!.newPage();
        await page.goto(url); await page.locator(".task-recovery button").click();
        await page.waitForFunction(() => (window as any).submits.length === 1);
        ids.push(await page.evaluate(() => (window as any).submits[0].requestId)); await page.close();
      }
      assert.equal(ids[0], ids[1]);
    });
  } finally { await browser?.close(); await server.close(); rmSync(cacheDir, { recursive:true, force:true }); }
});
