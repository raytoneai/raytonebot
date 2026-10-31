import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { findHeadlessShell } from "../pi/browser/browserService.ts";
import { DEFAULT_BOTS } from "./botAppearance.ts";
import { BOT_NAMES } from "./botProfiles.ts";

type Scenario = "approval" | "group";
type LiveState = { response?: ServerResponse; summaryRequests: number; title: string };

const runtimeState = {
  available: true, cwd: "/tmp/raytonebot-test", running: false, provider: "openai", model: "gpt-4o",
  models: [], tools: [], harnesses: [],
};
const botProfiles = [
  { id: "assistant", presetId: "assistant", name: BOT_NAMES.assistant, appearance: DEFAULT_BOTS.woman },
  { id: "planner", presetId: "planner", name: BOT_NAMES.planner, appearance: DEFAULT_BOTS.man },
  { id: "builder", presetId: "builder", name: BOT_NAMES.builder, appearance: DEFAULT_BOTS.boy },
];

function event(type: string, runId: string, payload: Record<string, unknown>, seq: number) {
  return { id: `${runId}-${seq}`, runId, seq, ts: seq, type, payload };
}

function approvalSnapshot() {
  return [
    event("run.started", "approval-run", {}, 1),
    event("tool.call.awaiting_approval", "approval-run", { toolCallId: "write", name: "write", title: "notes.md", argsPreview: {} }, 2),
  ];
}

function groupSnapshot() {
  return [
    event("run.started", "first-run", {}, 1),
    event("run.finished", "first-run", { status: "success" }, 2),
    event("run.started", "second-run", {}, 3),
  ];
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

test("AgentApp restores off-screen waits, settles run.error, and retitles later group turns", {
  skip: !findHeadlessShell() && "Chromium not installed", timeout: 60_000,
}, async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "rtb-agent-shell-reconnect-"));
  let scenario: Scenario = "approval";
  const live: LiveState = { summaryRequests: 0, title: "Old group title" };
  let snapshotEvents: ReturnType<typeof approvalSnapshot> = approvalSnapshot();
  const pageHtml = `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module">
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AgentApp } from '/src/agent-shell.tsx';
    import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
    import '/src/styles/app.css';
    createRoot(document.getElementById('root')).render(h(LocaleProvider, null, h(AgentApp)));
  </script>`;
  const server = await createServer({
    root: process.env.RAYTONEBOT_TEST_ROOT ?? process.cwd(),
    configFile: false,
    cacheDir,
    server: { host: "127.0.0.1", port: 0, hmr: false, ws: false },
    optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
    plugins: [react(), {
      name: "agent-shell-reconnect-test-libs",
      resolveId(id: string) { return id.startsWith("virtual:sandbox-lib/") ? `\0${id}` : undefined; },
      load(id: string) { return id.startsWith("\0virtual:sandbox-lib/") ? "export const code=''; export const exports={};" : undefined; },
    }, { name: "agent-shell-reconnect-test", configureServer(vite) {
      vite.middlewares.use("/agent-shell-reconnect", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await vite.transformIndexHtml("/agent-shell-reconnect", pageHtml));
      });
      vite.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? "/", "http://raytonebot.test");
        if (!requestUrl.pathname.startsWith("/__agentcanvas/pi")) { next(); return; }
        const path = requestUrl.pathname;
        const group = scenario === "group";
        const conversationId = group ? "group_reconnect" : "planner_approval";
        const events = group ? groupSnapshot() : snapshotEvents;
        const summary = {
          id: conversationId,
          title: group ? live.title : "Approval held", titleSource: group ? "summary" : undefined,
          createdAt: 1, updatedAt: 2, agentPreset: group ? "assistant" : "planner",
          eventCount: events.length, running: true,
          activeRunId: group ? "second-run" : "approval-run",
          awaitingUser: false,
          ...(group ? { group: { members: ["assistant", "planner"], hostId: "assistant", preserveTitle: false } } : {}),
        };
        if (path === "/__agentcanvas/pi/conversations" && req.method === "GET") {
          json(res, { conversations: [summary], unreadable: [] }); return;
        }
        if (path.startsWith("/__agentcanvas/pi/conversations/") && path.endsWith("/live")) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson");
          res.setHeader("cache-control", "no-store");
          res.flushHeaders?.();
          live.response = res;
          return;
        }
        if (path.startsWith("/__agentcanvas/pi/conversations/")) {
          if (requestUrl.searchParams.get("summary") === "1") {
            live.summaryRequests++;
            json(res, summary);
          } else {
            json(res, { ...summary, events });
          }
          return;
        }
        if (path === "/__agentcanvas/pi/config" || path === "/__agentcanvas/pi/state" || path === "/__agentcanvas/pi/session/new") {
          json(res, runtimeState); return;
        }
        if (path === "/__agentcanvas/pi/browser/state") { json(res, { available: false, running: false }); return; }
        if (path === "/__agentcanvas/pi/bots") { json(res, { revision: 1, profiles: botProfiles }); return; }
        if (path === "/__agentcanvas/pi/providers") { json(res, { revision: 1, providers: undefined }); return; }
        if (path === "/__agentcanvas/pi/channels") { json(res, { channels: [] }); return; }
        if (path === "/__agentcanvas/pi/routines") { json(res, { routines: [] }); return; }
        if (path === "/__agentcanvas/pi/mcp") { json(res, { servers: [] }); return; }
        if (path === "/__agentcanvas/pi/memories") { json(res, { enabled: false, memories: [] }); return; }
        if (path === "/__agentcanvas/pi/skills") { json(res, { revision: 1, skills: [] }); return; }
        if (path === "/__agentcanvas/pi/usage") { json(res, { entries: [] }); return; }
        json(res, {});
      });
    } }],
    resolve: { dedupe: ["react", "react-dom"] },
  });

  const sendLive = (value: unknown, end = false) => {
    assert.ok(live.response, "expected the page to open a live conversation stream");
    live.response.write(`${JSON.stringify(value)}\n`);
    if (end) live.response.end();
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: findHeadlessShell(), headless: true });
    const base = server.resolvedUrls!.local[0];
    await t.test("snapshot approval marks an off-screen Bot and run.error settles it", async () => {
      scenario = "approval";
      snapshotEvents = approvalSnapshot();
      live.title = "Old group title";
      live.response = undefined;
      live.summaryRequests = 0;
      const approvalPage = await browser!.newPage();
      try {
      await approvalPage.clock.install();
      await approvalPage.goto(`${base}agent-shell-reconnect`);
      await approvalPage.locator('.shell-agent-face[data-status="needs-you"]').waitFor();
      assert.equal(await approvalPage.locator('.shell-agent-face[data-status="needs-you"]').count(), 1,
        "a snapshot approval is visible for an off-screen Bot even when the list said awaitingUser=false");

      // run.error is terminal for the wait immediately, even while the HTTP reader remains open.
      sendLive(event("run.error", "approval-run", { message: "controlled failure" }, 3));
      await approvalPage.waitForFunction(() => !document.querySelector('.shell-agent-face[data-status="needs-you"]'));
      sendLive(event("run.finished", "approval-run", { status: "error" }, 4), true);
      await approvalPage.waitForFunction(() => !document.querySelector('.shell-agent-face[data-status="running"]'));
      } finally { await approvalPage.close(); }
    });

    await t.test("a later group turn refreshes and adopts its summary title", async () => {
      scenario = "group";
      snapshotEvents = groupSnapshot();
      live.title = "Old group title";
      live.response = undefined;
      live.summaryRequests = 0;
      const groupPage = await browser!.newPage();
      try {
        await groupPage.clock.install();
        await groupPage.goto(`${base}agent-shell-reconnect`);
        const liveDeadline = Date.now() + 5_000;
        while (!live.response && Date.now() < liveDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(live.response, "group follow opened its live stream");
        await groupPage.locator(".session-bot-toggle").first().click();
        await groupPage.getByText("Old group title", { exact: true }).waitFor();
        live.title = "New group title";
        sendLive(event("run.finished", "second-run", { status: "success" }, 4), true);
        const summaryDeadline = Date.now() + 5_000;
        while (live.summaryRequests < 1 && Date.now() < summaryDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(live.summaryRequests >= 1, "a later group turn asks the host for its summary title");
        await groupPage.getByText("New group title", { exact: true }).waitFor();
      } finally { await groupPage.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
