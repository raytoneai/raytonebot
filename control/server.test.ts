import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Platform } from "./agentsphere.ts";
import type { RunProcess } from "./provision.ts";
import { Store } from "./store.ts";

const origin = "http://127.0.0.1:5199";

test("two tabs claiming at the same moment create one bot", async () => {
  // Read when the module loads, so they are set before it is imported.
  process.env.CONTROL_DEV_USER = "owner-1";
  process.env.CONTROL_PUBLIC_ORIGIN = origin;
  try {
    const { serve } = await import("./server.ts");
    const store = new Store(mkdtempSync(join(tmpdir(), "control-claim-http-")));
    const platform: Platform = {
      async create() { return "sbx"; },
      async info() { return undefined; },
      async resume() {},
      async renew() {},
    };
    const run: RunProcess = async () => ({ code: 1, tail: ["FAIL: no deploy in this test"] });
    const context = { store, platform, run, repoRoot: "/repo", python: "py", template: "agentmatrix-v1", initialTimeoutS: 7200 };
    const server = serve(store, platform, context, { store, platform, run, repoRoot: "/repo", python: "py", log: () => {} });
    const handle = server.listeners("request")[0] as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>;

    // Both bodies arrive only after both handlers have read ownership, the interleaving in which
    // each request saw "no bot yet" and went on to create one.
    let started = 0;
    let release: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const claim = () => {
      started += 1;
      if (started === 2) release();
      const response = {
        statusCode: 0, headers: {} as Record<string, unknown>, body: "",
        setHeader(name: string, value: unknown) { this.headers[name] = value; },
        writeHead(status: number, headers?: Record<string, unknown>) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); },
        end(body?: string) { this.body = body ?? ""; },
      };
      const request = {
        method: "POST", url: "/api/bot/claim",
        headers: { origin, "content-type": "application/json" },
        async *[Symbol.asyncIterator]() { await bothStarted; yield Buffer.from("{}"); },
      };
      return { response, done: handle(request as unknown as IncomingMessage, response as unknown as ServerResponse) };
    };
    const [first, second] = [claim(), claim()];
    await Promise.all([first.done, second.done]);

    assert.deepEqual([first.response.statusCode, second.response.statusCode].sort((a, b) => a - b), [200, 201],
      "one claim creates the bot, the other adopts it");
    assert.equal(store.list().length, 1, "one owner gets one bot, whichever tab asked first");
    assert.equal(store.ownedBy("owner-1")!.id, store.list()[0].id);
    server.close();
  } finally {
    delete process.env.CONTROL_DEV_USER;
    delete process.env.CONTROL_PUBLIC_ORIGIN;
  }
});
