import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dshInstallation, DSH_VERSION } from "./cliHarnessConfig.ts";

test("DSH status and launcher require the same pinned installation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rtb-dsh-version-"));
  const pkg = join(dir, "package.json");
  const binary = join(dir, "lib", "bin.js");
  mkdirSync(join(dir, "lib"));
  writeFileSync(binary, "#!/bin/sh\necho 0.2.1-rc.5\n", { mode: 0o755 });
  const env = { ...process.env, RAYTONEBOT_DSH_BIN: binary };
  const status = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    'import {detectCliHarnesses} from "./src/pi/cliHarness.ts"; console.log(JSON.stringify((await detectCliHarnesses()).find(x => x.id === "dsh")))'], { env, encoding: "utf8" }));
  try {
    writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.5" }));
    assert.throws(() => dshInstallation(env), /requires.*0\.2\.1-rc\.2/);
    assert.equal(status().available, false);
    writeFileSync(pkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: DSH_VERSION }));
    assert.equal(dshInstallation(env), realpathSync(pkg));
    assert.equal(status().available, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
