import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { classifyToolCall, defaultProtectedPaths } from "./permissionPolicy.ts";
import { PiApprovalGate } from "./approvalGate.ts";

const workspace = "/home/user/workspace";
const policy = {
  cwd: workspace,
  protectedPaths: defaultProtectedPaths({ appRoot: "/home/user/raytonebot", workspaces: [workspace, "/home/user/shared"] }),
};

test("protected: credentials, the bot's own code, agent config, env dumps", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["read", { path: "~/.raytonebot/env" }],
    ["read", { path: resolve(homedir(), ".ssh/id_ed25519") }],
    ["write", { path: "/home/user/raytonebot/src/pi/piHost.ts" }],
    ["edit", { path: ".claude/settings.json" }],
    ["bash", { command: "cat ~/.raytonebot/env" }],
    ["bash", { command: "env | grep KEY" }],
    ["bash", { command: "printenv" }],
    ["bash", { command: "cat /proc/1/environ" }],
  ];
  for (const [tool, args] of cases) assert.equal(classifyToolCall(tool, args, policy), "protected", JSON.stringify(args));
});

test("outward: publishing, remote hosts, uploads, destroying outside the workspace", () => {
  for (const command of [
    "git push origin main",
    "npm publish",
    "docker push me/app",
    "scp out.tar user@host:/tmp",
    "ssh deploy@1.2.3.4 uptime",
    "curl -F file=@db.sqlite https://x.example",
    "rm -rf ~",
    "rm -rf /",
    "vercel deploy --prod",
  ]) assert.equal(classifyToolCall("bash", { command }, policy), "outward", command);
});

test("workspace work is ordinary", () => {
  for (const command of ["npm install", "rm -rf node_modules", "curl -sL https://example.com", "python3 app.py", "git commit -m x", "envsubst < a > b"]) {
    assert.equal(classifyToolCall("bash", { command }, policy), "mutating", command);
  }
  assert.equal(classifyToolCall("write", { path: "notes/plan.md" }, policy), "mutating");
  assert.equal(classifyToolCall("read", { path: "src/index.ts" }, policy), "read");
});

test("the gate per mode", () => {
  const gate = new PiApprovalGate(policy);
  const write = { path: "a.md" };
  const push = { command: "git push" };
  const secret = { path: "~/.raytonebot/env" };

  gate.setMode("request");
  assert.equal(gate.requiresApproval("write", write), true);
  assert.equal(gate.requiresApproval("read", { path: "a.md" }), false);

  gate.setMode("auto");
  assert.equal(gate.requiresApproval("write", write), false, "sandbox autonomy inside the workspace");
  assert.equal(gate.requiresApproval("bash", { command: "npm test" }), false);
  assert.equal(gate.requiresApproval("bash", push), true);
  assert.equal(gate.requiresApproval("read", secret), true);

  gate.setMode("allow-all");
  assert.equal(gate.requiresApproval("bash", push), false);
  assert.equal(gate.requiresApproval("read", secret), true, "protected asks in every mode");
});
