import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { ENV_PREAMBLE, envPreamble } from "./runtime/agentProcess.ts";

test("isolated launches pass environment through stdin, not argv, and keep the rest of stdin intact", async () => {
  const preamble = envPreamble({ TOKEN: "lease $HOME `x` 'q' a=b", PATH: process.env.PATH, "BASH_FUNC_x%%": "() { :; }", MULTI: "a\nb", EMPTY: "" });
  assert.equal(preamble.includes("BASH_FUNC"), false);
  assert.equal(preamble.includes("MULTI"), false);
  const child = spawn("/bin/sh", ["-c", ENV_PREAMBLE, "sh", "/bin/sh", "-c", 'printf "%s|%s|" "$TOKEN" "${EMPTY-unset}"; cat'], { env: {} });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${preamble}{"type":"user"}\n`);
  await new Promise((resolve) => child.on("close", resolve));
  assert.equal(output, "lease $HOME `x` 'q' a=b||{\"type\":\"user\"}\n");
});
