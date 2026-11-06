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
type LiveState = {
  response?: ServerResponse;
  holdInitialConversations: boolean;
  initialConversationsResponse?: ServerResponse;
  releaseInitialConversations: () => void;
  conversationsRequests: number;
  summaryRequests: number;
  title: string;
  liveOpened: number;
  liveClosed: number;
  trackUnmount: boolean;
  requestsAfterUnmount: string[];
};

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
    event("text.started", "first-run", { role: "user", textId: "group-request" }, 2),
    event("text.delta", "first-run", { textId: "group-request", delta: "Discuss the project" }, 3),
    event("text.completed", "first-run", { textId: "group-request" }, 4),
    event("run.finished", "first-run", { status: "success" }, 5),
    event("run.started", "second-run", {}, 6),
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
  const live: LiveState = {
    holdInitialConversations: false,
    releaseInitialConversations: () => {},
    conversationsRequests: 0,
    summaryRequests: 0,
    title: "Old group title",
    liveOpened: 0,
    liveClosed: 0,
    trackUnmount: false,
    requestsAfterUnmount: [],
  };
  let snapshotEvents: ReturnType<typeof approvalSnapshot> = approvalSnapshot();
  const pageHtml = `<meta name="viewport" content="width=device-width, initial-scale=1"><button id="unmount-app" type="button">Unmount</button><div id="root"></div><script type="module">
    import { createElement as h, StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AgentApp } from '/src/agent-shell.tsx';
    import { LocaleProvider } from '/src/i18n/LocaleContext.tsx';
    import '/src/styles/app.css';
    const appRoot = createRoot(document.getElementById('root'));
    const strict = new URLSearchParams(location.search).has('strict');
    appRoot.render(strict ? h(StrictMode, null, h(LocaleProvider, null, h(AgentApp))) : h(LocaleProvider, null, h(AgentApp)));
    document.getElementById('unmount-app').addEventListener('click', () => appRoot.unmount());
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
        if (live.trackUnmount) live.requestsAfterUnmount.push(`${req.method ?? "GET"} ${path}`);
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
          live.conversationsRequests++;
          if (live.holdInitialConversations) {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.flushHeaders?.();
            live.initialConversationsResponse = res;
            live.releaseInitialConversations = () => {
              if (!res.writableEnded) res.end(JSON.stringify({ conversations: [summary], unreadable: [] }));
            };
            return;
          }
          json(res, { conversations: [summary], unreadable: [] }); return;
        }
        if (path.startsWith("/__agentcanvas/pi/conversations/") && path.endsWith("/live")) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/x-ndjson");
          res.setHeader("cache-control", "no-store");
          res.flushHeaders?.();
          live.liveOpened++;
          res.once("close", () => { live.liveClosed++; });
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

    await t.test("unmount closes the live subscription without stopping the host", async () => {
      scenario = "approval";
      snapshotEvents = approvalSnapshot();
      live.response = undefined;
      live.trackUnmount = false;
      live.requestsAfterUnmount = [];
      const openedBefore = live.liveOpened;
      const closedBefore = live.liveClosed;
      const page = await browser!.newPage();
      try {
        await page.clock.install();
        await page.goto(`${base}agent-shell-reconnect`);
        const liveDeadline = Date.now() + 5_000;
        while ((!live.response || live.liveOpened <= openedBefore) && Date.now() < liveDeadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(live.response && live.liveOpened > openedBefore, "the test page must hold its live HTTP subscription open");

        live.trackUnmount = true;
        await page.locator("#unmount-app").evaluate(button => (button as HTMLButtonElement).click());
        await page.waitForFunction(() => document.getElementById("root")?.childElementCount === 0);
        const closeDeadline = Date.now() + 5_000;
        while (live.liveClosed <= closedBefore && Date.now() < closeDeadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(live.liveClosed, closedBefore + 1, "React unmount closes the live HTTP subscription");
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(live.requestsAfterUnmount, [], "unmount does not call host or abort endpoints");
      } finally {
        live.trackUnmount = false;
        await page.close();
      }
    });

    await t.test("StrictMode effect replay preserves the initial live follow", async () => {
      scenario = "approval";
      snapshotEvents = approvalSnapshot();
      live.response = undefined;
      live.holdInitialConversations = false;
      live.conversationsRequests = 0;
      live.trackUnmount = false;
      live.requestsAfterUnmount = [];
      const openedBefore = live.liveOpened;
      const closedBefore = live.liveClosed;
      const page = await browser!.newPage();
      try {
        await page.clock.install();
        await page.goto(`${base}agent-shell-reconnect?strict=1`);
        const liveDeadline = Date.now() + 5_000;
        while ((!live.response || live.liveOpened <= openedBefore) && Date.now() < liveDeadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        const requestsDeadline = Date.now() + 5_000;
        while (live.conversationsRequests < 2 && Date.now() < requestsDeadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(live.conversationsRequests >= 2, "StrictMode root replay must issue the initial history list twice");
        assert.ok(live.response && live.liveOpened > openedBefore, "StrictMode replay must still open the initial live subscription");

        await page.locator("#unmount-app").evaluate(button => (button as HTMLButtonElement).click());
        await page.waitForFunction(() => document.getElementById("root")?.childElementCount === 0);
        live.trackUnmount = true;
        const closeDeadline = Date.now() + 5_000;
        while (live.liveClosed <= closedBefore && Date.now() < closeDeadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        await page.clock.fastForward(16_000);
        assert.equal(live.liveClosed, closedBefore + 1, "StrictMode unmount closes its live subscription");
        assert.deepEqual(live.requestsAfterUnmount, [], "StrictMode unmount does not call host or abort endpoints");
      } finally {
        live.trackUnmount = false;
        await page.close();
      }
    });

    await t.test("unmount before the initial conversation list resolves does not restart a follow", async () => {
      scenario = "approval";
      snapshotEvents = approvalSnapshot();
      live.response = undefined;
      live.holdInitialConversations = true;
      live.initialConversationsResponse = undefined;
      live.releaseInitialConversations = () => {};
      live.trackUnmount = false;
      live.requestsAfterUnmount = [];
      const page = await browser!.newPage();
      try {
        await page.clock.install();
        const heldListResponsePromise = page.waitForResponse(response => {
          const url = new URL(response.url());
          return response.request().method() === "GET" && url.pathname === "/__agentcanvas/pi/conversations";
        });
        await page.goto(`${base}agent-shell-reconnect`);
        const heldListResponse = await heldListResponsePromise;
        const historyDeadline = Date.now() + 5_000;
        while (!live.initialConversationsResponse && Date.now() < historyDeadline)
          await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(live.initialConversationsResponse, "the test page must hold the initial conversation list open");

        await page.locator("#unmount-app").evaluate(button => (button as HTMLButtonElement).click());
        await page.waitForFunction(() => document.getElementById("root")?.childElementCount === 0);
        live.trackUnmount = true;
        live.holdInitialConversations = false;
        const responseFinished = heldListResponse.finished();
        live.releaseInitialConversations();
        await responseFinished;
        await page.clock.fastForward(16_000);
        assert.deepEqual(live.requestsAfterUnmount, [], "a late initial history response does not start history/live/retry requests after unmount");
      } finally {
        live.trackUnmount = false;
        live.holdInitialConversations = false;
        live.releaseInitialConversations();
        await page.close();
      }
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
        await groupPage.locator(".shell-group-rail").click();
        await groupPage.waitForFunction(() => document.querySelector(".preview-frame")?.getAttribute("data-conversation-id") === "group_reconnect", undefined, { timeout: 3_000 });
        assert.equal(await groupPage.locator(".shell-group-rail").getAttribute("data-active"), "true", "one group click changes the active conversation, not only the history filter");
        await groupPage.locator(".shell-chat-participants .shell-header-agent").getByText("Old group title", { exact: true }).waitFor();
        await groupPage.locator(".session-history-panel").getByText("Old group title", { exact: true }).waitFor();
        live.title = "New group title";
        sendLive(event("run.finished", "second-run", { status: "success" }, 7), true);
        const summaryDeadline = Date.now() + 5_000;
        while (live.summaryRequests < 1 && Date.now() < summaryDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(live.summaryRequests >= 1, "a later group turn asks the host for its summary title");
        await groupPage.locator(".session-history-panel").getByText("New group title", { exact: true }).waitFor();
      } finally { await groupPage.close(); }
    });
    for (const width of [1280, 682, 390]) {
      await t.test(`${width}px: one group-rail click enters the group conversation`, async () => {
        scenario = "group"; live.response = undefined;
        const page = await browser!.newPage({ viewport: { width, height: 925 }, reducedMotion: "reduce" });
        try {
          await page.goto(`${base}agent-shell-reconnect`);
          const deadline = Date.now() + 5_000;
          while (!live.response && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          assert.ok(live.response, "saved group metadata has loaded");
          if (!await page.locator(".shell-group-rail").isVisible()) await page.locator('.preview-rail-float[data-side="left"]').click();
          await page.locator(".shell-group-rail").click();
          await page.waitForFunction(() => document.querySelector(".preview-frame")?.getAttribute("data-conversation-id") === "group_reconnect", undefined, { timeout: 3_000 });
          assert.equal(await page.locator(".shell-group-rail").getAttribute("data-active"), "true");
          await page.locator(".shell-chat-participants .shell-header-agent").getByText(live.title, { exact: true }).waitFor();
          if (width < 860) assert.equal(await page.locator('.artifact-frame[role="dialog"]').count(), 0, "group entry shows the chat without a second selection behind a modal");
        } finally { await page.close(); }
      });
    }
    await t.test("without group history, the group rail opens member selection instead of a single-Bot chat", async () => {
      scenario = "approval"; snapshotEvents = approvalSnapshot(); live.response = undefined;
      const page = await browser!.newPage();
      try {
        await page.goto(`${base}agent-shell-reconnect`);
        await page.locator('.shell-agent-face[data-status="needs-you"]').waitFor();
        assert.equal(await page.locator('.chat-frame .shell-header-agent').isVisible(), false, "a fresh Bot welcome has no repeated header avatar");
        await page.locator(".shell-group-rail").click();
        await page.waitForFunction(() => document.querySelector(".preview-frame")?.getAttribute("data-conversation-id")?.startsWith("group_"));
        await page.locator(".composer-greeting .shell-member-picker").waitFor();
        assert.equal(await page.locator(".shell-group-rail").getAttribute("data-active"), "true");
      } finally { await page.close(); }
    });
  } finally {
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
