import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { chromium } from "playwright-core";
import { findHeadlessShell } from "../../src/pi/browser/browserService.ts";
import { createServer as createViteServer } from "vite";

const outputDir = dirname(new URL(import.meta.url).pathname);
const reportPath = join(outputDir, "fixture-results.json");
const isolatedRoot = mkdtempSync(join(tmpdir(), "rtb-fixture-browser-"));
const isolatedData = join(isolatedRoot, "data");
const isolatedWorkspace = join(isolatedRoot, "workspace");
const isolatedVault = join(isolatedRoot, "vault");
const browserPath = findHeadlessShell();

// The app's Pi plugin is kept, but every host path is isolated and empty. No model, IM,
// routine, or user-data request is made by this check.
process.env.RAYTONEBOT_DATA_DIR = isolatedData;
process.env.RAYTONEBOT_WORKSPACE_ROOT = isolatedWorkspace;
process.env.RAYTONEBOT_VAULT_DIR = isolatedVault;
process.env.RAYTONEBOT_SANDBOX = "0";
if (browserPath) process.env.RAYTONEBOT_BROWSER_PATH = browserPath;

const report = {
  kind: "fixture-browser-check",
  generatedAt: new Date().toISOString(),
  fixtureRule: "?devtools=1 picker; 19 event streams plus welcome page",
  isolated: true,
  viewportTargets: { desktop: { width: 1280, height: 900 }, mobile: { width: 390, height: 844 } },
  screenshots: [],
  viewports: [],
  fatal: [],
};

const screenshotPlan = new Map([
  ["desktop|欢迎页(无事件)", "fixture-welcome-desktop.png"],
  ["desktop|Tool approval", "fixture-tool-approval-desktop.png"],
  ["desktop|HTML artifact stream", "fixture-html-artifact-desktop.png"],
  ["mobile|Group chat", "fixture-group-chat-mobile.png"],
  ["mobile|Terminal incident", "fixture-terminal-incident-mobile.png"],
]);

const eventLog = { pageErrors: [], consoleErrors: [], failedRequests: [], httpErrors: [] };
const markEvents = () => Object.fromEntries(Object.entries(eventLog).map(([key, values]) => [key, values.length]));
const eventsSince = (mark) => Object.fromEntries(Object.entries(eventLog).map(([key, values]) => [key, values.slice(mark[key])]));
const waitForPaint = async (page) => {
  await page.waitForTimeout(120);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

async function inspectPage(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const frame = document.querySelector(".preview-frame");
    const frameText = frame?.innerText?.trim() ?? "";
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    return {
      previewFrame: visible(frame),
      previewFrameTextLength: frameText.length,
      shellHeader: visible(document.querySelector(".shell-header")),
      composer: visible(document.querySelector("textarea")),
      sidebar: Boolean(document.querySelector(".session-sidebar, .compact-drawer")),
      chatFrame: Boolean(document.querySelector(".chat-frame")),
      toolCards: document.querySelectorAll(".tool-call-card").length,
      artifactCards: document.querySelectorAll("[data-artifact-id], .artifact-card").length,
      overflow: scrollWidth > window.innerWidth + 1,
      scrollWidth,
      innerWidth: window.innerWidth,
      bodyTextLength: (document.body.innerText ?? "").trim().length,
    };
  });
}

async function openPicker(page) {
  const picker = page.getByLabel(/选择事件流|event stream/i).first();
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  if ((await picker.getAttribute("aria-expanded")) !== "true") await picker.click();
  await page.getByRole("menuitemradio").first().waitFor({ state: "visible", timeout: 5_000 });
  return picker;
}

async function readLabels(page) {
  await openPicker(page);
  const labels = (await page.getByRole("menuitemradio").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  await page.keyboard.press("Escape");
  return labels;
}

async function selectLabel(page, picker, label) {
  if ((await picker.getAttribute("aria-expanded")) !== "true") await picker.click();
  const option = page.getByRole("menuitemradio", { name: label, exact: true });
  await option.waitFor({ state: "visible", timeout: 5_000 });
  await option.click();
  await waitForPaint(page);
}

async function runViewport(page, baseUrl, viewportName, width, height, expectedLabels) {
  await page.setViewportSize({ width, height });
  const startupMark = markEvents();
  await page.goto(`${baseUrl}/?devtools=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator(".preview-frame").waitFor({ state: "visible", timeout: 15_000 });
  await waitForPaint(page);
  const picker = page.getByLabel(/选择事件流|event stream/i).first();
  const labels = await readLabels(page);
  assert.equal(labels.length, 20, `${viewportName}: expected welcome plus 19 built-in streams`);
  if (expectedLabels) assert.deepEqual(labels, expectedLabels, `${viewportName}: fixture labels changed between viewports`);

  const startupEvents = eventsSince(startupMark);
  const viewportReport = {
    viewport: viewportName,
    width,
    height,
    labels,
    startup: { ok: !startupEvents.pageErrors.length && !startupEvents.consoleErrors.length && !startupEvents.httpErrors.length, events: startupEvents },
    results: [],
  };
  for (const label of labels) {
    const before = markEvents();
    await selectLabel(page, picker, label);
    const content = await inspectPage(page);
    const events = eventsSince(before);
    const screenshotName = screenshotPlan.get(`${viewportName}|${label}`);
    let screenshot;
    if (screenshotName) {
      const screenshotPath = join(outputDir, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      screenshot = relative(process.cwd(), screenshotPath);
      report.screenshots.push(screenshot);
    }
    const contentOk = content.previewFrame && content.previewFrameTextLength > 10 && content.bodyTextLength > 10;
    const errorsOk = !events.pageErrors.length && !events.consoleErrors.length && !events.httpErrors.length;
    const ok = contentOk && !content.overflow && errorsOk;
    viewportReport.results.push({ label, ok, contentOk, content, events, ...(screenshot ? { screenshot } : {}) });
  }
  report.viewports.push(viewportReport);
  return labels;
}

let vite;
let browser;
let context;
let page;
try {
  if (!browserPath) throw new Error("findHeadlessShell() did not find a Chromium headless shell.");

  const { default: viteConfig } = await import("../../vite.config.ts");
  vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    logLevel: "silent",
    server: { ...viteConfig.server, host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose an isolated HTTP port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  report.baseUrl = baseUrl;
  // Seed only the exported provider catalog in the isolated host. This lets the app's normal
  // startup configuration resolve without a credential or model request.
  const { project } = await import("../../src/exported-project.ts");
  const isolatedProviders = structuredClone(project.providers);
  isolatedProviders.defaultProviderId = "local";
  isolatedProviders.connections = isolatedProviders.connections.map((provider) => provider.id === "local"
    ? { ...provider, enabled: true, defaultModel: "fixture-model", models: ["fixture-model"] }
    : { ...provider, enabled: false });
  const providerState = await (await fetch(`${baseUrl}/__agentcanvas/pi/providers`)).json();
  const providerSave = await fetch(`${baseUrl}/__agentcanvas/pi/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers: isolatedProviders, keys: {}, removeKeys: [], revision: providerState.revision }),
  });
  if (!providerSave.ok) throw new Error(`Isolated provider seed failed: HTTP ${providerSave.status}`);
  report.isolatedProviderSeed = true;

  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => {
    localStorage.setItem("raytonebot.providerSettings", JSON.stringify({ version: 1, defaultProviderId: "local", connections: [
      { id: "deepseek", enabled: false }, { id: "local", enabled: true, defaultModel: "fixture-model", models: ["fixture-model"] },
    ] }));
  });
  page = await context.newPage();
  page.on("pageerror", (error) => eventLog.pageErrors.push({ message: error.message }));
  page.on("console", (message) => { if (message.type() === "error") eventLog.consoleErrors.push({ text: message.text(), location: message.location() }); });
  page.on("requestfailed", (request) => eventLog.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? "unknown" }));
  page.on("response", (response) => {
    if (response.status() >= 500) void response.text().then((body) => eventLog.httpErrors.push({ url: response.url(), status: response.status(), body: body.slice(0, 500) })).catch(() => eventLog.httpErrors.push({ url: response.url(), status: response.status() }));
  });

  const desktopLabels = await runViewport(page, baseUrl, "desktop", 1280, 900);
  await runViewport(page, baseUrl, "mobile", 390, 844, desktopLabels);
} catch (error) {
  report.fatal.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  rmSync(isolatedRoot, { recursive: true, force: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

const results = report.viewports.flatMap((viewport) => viewport.results);
const failures = results.filter((result) => !result.ok);
const startupFailures = report.viewports.filter((viewport) => !viewport.startup.ok).map((viewport) => viewport.viewport);
const summary = {
  viewports: report.viewports.map((viewport) => ({ viewport: viewport.viewport, scenarios: viewport.results.length })),
  scenariosChecked: results.length,
  expectedScenarios: 40,
  failures: failures.length + startupFailures.length,
  startupFailures,
  fatal: report.fatal.length,
  screenshots: report.screenshots,
  report: relative(process.cwd(), reportPath),
};
console.log(JSON.stringify(summary, null, 2));
if (report.fatal.length || failures.length !== 0 || startupFailures.length !== 0 || results.length !== 40) process.exitCode = 1;
