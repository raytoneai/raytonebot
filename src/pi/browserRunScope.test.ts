import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserService, type BrowserToolContext } from "./browser/browserService.ts";
import { BROWSER_TOOL_SPECS } from "./browser/browserTools.ts";
import { createPiRuntimeController } from "./piRuntimeController.ts";
import type { HostTools } from "./memories.ts";

test("cached Pi browser toolkit reads each live run and runtime releases snapshots on finish and stop", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-live-run-"));
  const browser = createBrowserService({ dataDir, executable: "/unused-test-chrome" });
  const originalToolsFor = browser.toolsFor.bind(browser), originalRelease = browser.releaseRun.bind(browser);
  let context!: BrowserToolContext, cached!: HostTools, created = 0, hold = false;
  const observed: (string | undefined)[] = [], releases: [string, string][] = [];
  let started!: () => void, finish!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  browser.toolsFor = value => { context = value; return originalToolsFor(value); };
  browser.releaseRun = (conversationId, runId) => { releases.push([conversationId, runId]); originalRelease(conversationId, runId); };
  const controller = createPiRuntimeController({ cwd: dataDir, dataDir, browser, bridgeFactory: async ({ hostTools }) => {
    created++; cached = hostTools!;
    return {
      subscribe: () => () => {},
      async prompt() {
        observed.push(context.currentRunId?.());
        const result = await cached.run("browser_snapshot", { offset: 0 });
        assert.match(result.text, /missing snapshotId/, "active run reaches identity validation without starting Chrome");
        if (hold) { started(); await new Promise<void>(resolve => { finish = resolve; }); }
      },
      async abort() { assert.equal(context.currentRunId?.(), undefined); finish?.(); }, dispose() {},
      configure: async () => {}, state: async () => ({ models: [], tools: [] }), newSession: async () => {},
    };
  } });
  try {
    const schema = BROWSER_TOOL_SPECS.find(spec => spec.name === "browser_snapshot")!.inputSchema as { properties: Record<string, unknown> };
    for (const name of ["snapshotId", "offset", "limit", "mode", "scope", "frameRef"]) assert.ok(schema.properties[name]);
    for (const requestId of ["first", "second"]) {
      await controller.runPrompt({ conversationId: "scope", requestId, prompt: "Inspect the page" }, () => {});
      assert.equal(context.currentRunId?.(), undefined);
      assert.match((await cached.run("browser_snapshot", { offset: 0 })).text, /run is no longer active/);
    }
    assert.equal(created, 1, "Pi keeps the original bridge and hostTools for its next turn");
    assert.deepEqual(observed, ["first", "second"]);
    assert.deepEqual(releases, [["scope", "first"], ["scope", "second"]]);
    hold = true;
    const pending = controller.runPrompt({ conversationId: "scope", requestId: "stopped", prompt: "Wait" }, () => {});
    await running;
    assert.equal(await controller.abort("scope", "stopped"), true);
    await pending;
    assert.deepEqual(releases.slice(2), [["scope", "stopped"], ["scope", "stopped"]], "stop invalidates immediately; final cleanup is safe to repeat");
    assert.equal(context.currentRunId?.(), undefined);
    assert.equal(browser.view().running, false);
  } finally { await controller.dispose(); await browser.stop(); rmSync(dataDir, { recursive: true, force: true }); }
});
