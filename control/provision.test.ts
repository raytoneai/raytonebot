import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Platform, SandboxInfo } from "./agentsphere.ts";
import { deployStage, failureLine, provision, type ProvisionContext, type RunProcess } from "./provision.ts";
import { readAccess, Store } from "./store.ts";

test("deploy output lines move the progress forward", () => {
  assert.equal(deployStage("upload: 812 KB to sbx"), "upload");
  assert.equal(deployStage("deps: npm ci (lockfile changed)"), "deps");
  assert.equal(deployStage("browser: headless shell 1187"), "browser");
  assert.equal(deployStage("isolation: native boundary verified"), "configure");
  assert.equal(deployStage("env: written (A, B)"), "start");
  assert.equal(deployStage("start: pid 42"), "verify");
  assert.equal(deployStage("checks: authenticated page; ..."), undefined);
  assert.equal(deployStage("harness pi: available"), undefined);
  assert.equal(failureLine(["a", "FAIL: first", "b", "FAIL: check failed: Pi state"]), "check failed: Pi state");
  assert.equal(failureLine(["fine"]), undefined);
});

function fixture(options: { deploy: { code: number; lines: string[] }; existing?: SandboxInfo }) {
  const store = new Store(mkdtempSync(join(tmpdir(), "control-")));
  const calls: string[] = [];
  let clock = 1000;
  const platform: Platform = {
    async create(template, timeout) { calls.push(`create ${template} ${timeout}`); return "sbxnew"; },
    async info(id) { calls.push(`info ${id}`); return options.existing; },
    async resume(id) { calls.push(`resume ${id}`); },
    async renew() { throw new Error("unused"); },
  };
  const run: RunProcess = async (command, args, _options, onLine) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git") return { code: 0, tail: args[0] === "rev-parse" ? ["abc123"] : [] };
    if (command === "npm") return { code: 0, tail: [] };
    for (const line of options.deploy.lines) { clock += 10; onLine?.(line); }
    return { code: options.deploy.code, tail: options.deploy.lines };
  };
  const context: ProvisionContext = { store, platform, run, repoRoot: "/repo", python: "py", controlOrigin: "https://raytone.example.com",
    template: "agentmatrix-v1", initialTimeoutS: 7200, now: () => clock };
  return { store, calls, context };
}

test("a claim creates the sandbox, writes the bot's access, deploys and becomes ready", async () => {
  const { store, calls, context } = fixture({ deploy: { code: 0, lines: ["upload: 1 KB", "deps: unchanged", "browser: ok",
    "isolation: ok", "env: written", "start: pid 9", "checks: all"] } });
  const bot = store.create("u");
  await provision(context, bot.id);
  const record = store.get(bot.id)!;
  assert.equal(record.status, "ready");
  assert.equal(record.sandboxId, "sbxnew");
  assert.equal(record.url, "https://5188-sbxnew.agentsphere.run");
  assert.equal(record.stage, undefined);
  assert.ok(Object.values(record.stages).every((stage) => stage.endedAt !== undefined), "every stage closed");
  assert.equal(Object.keys(record.stages).length, 8);
  const access = readAccess(store, bot.id);
  assert.ok(access.password.length >= 24);
  assert.match(access.handoffSecret!, /^[0-9a-f]{64}$/);
  assert.equal(access.controlOrigin, "https://raytone.example.com");
  assert.equal(statSync(join(store.botDir(bot.id), "access.json")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(store.dir, "store.json"), "utf8").includes(access.password), "no secret in the store");
  assert.ok(calls.includes(`py /repo/scripts/agentsphere/deploy.py --sandbox sbxnew --state-dir ${store.botDir(bot.id)} --skip-build`));
  assert.ok(calls.includes("create agentmatrix-v1 7200"));
});

test("a failed deploy names its stage; a retry reuses the sandbox and the secrets", async () => {
  const failing = fixture({ deploy: { code: 1, lines: ["upload: 1 KB", "deps: npm ci", "FAIL: remote command failed (1): cd /home/user"] } });
  const { store, context } = failing;
  const bot = store.create("u");
  await provision(context, bot.id);
  const failed = store.get(bot.id)!;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, { stage: "deps", message: "remote command failed (1): cd /home/user" });
  const firstAccess = readAccess(store, bot.id);

  const again = fixture({ deploy: { code: 0, lines: ["start: pid 1"] }, existing: { state: "paused" } });
  const retry = { ...again.context, store };
  await provision(retry, bot.id);
  assert.equal(store.get(bot.id)!.status, "ready");
  assert.equal(store.get(bot.id)!.error, undefined);
  assert.ok(!again.calls.some((call) => call.startsWith("create")), "sandbox reused");
  assert.ok(again.calls.includes("resume sbxnew"), "a paused sandbox is resumed first");
  assert.deepEqual(readAccess(store, bot.id), firstAccess, "same password and handoff secret");
});

test("the store keeps one bot per owner and survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-"));
  const store = new Store(dir);
  const bot = store.create("alice");
  store.update(bot.id, (record) => { record.keepAwake = true; });
  const reloaded = new Store(dir);
  assert.equal(reloaded.ownedBy("alice")?.id, bot.id);
  assert.equal(reloaded.ownedBy("alice")?.keepAwake, true);
  assert.equal(reloaded.ownedBy("bob"), undefined);
  assert.equal(statSync(join(dir, "store.json")).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});
