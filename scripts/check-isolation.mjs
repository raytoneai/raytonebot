#!/usr/bin/env node
/** Run as the bot user after deployment, inside an isolated Linux test sandbox. No model calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer } from "node:net";
import { spawnAgentProcess, requireAgentIsolation, gatewayPort } from "../src/pi/runtime/agentProcess.ts";
import { scrubSecretEnv } from "../src/pi/runtime/childEnv.ts";
import { createModelGateway } from "../src/pi/runtime/modelGateway.ts";

requireAgentIsolation();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = process.env.RAYTONEBOT_WORKSPACE_ROOT;
assert.ok(workspace, "workspace root required");
const port = gatewayPort();
let gateway;
try { gateway = await createModelGateway(); } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
const ipv6Server = createServer(socket => socket.end());
await new Promise((resolve, reject) => { ipv6Server.once("error", reject); ipv6Server.listen(0, "::1", resolve); });
const ipv6Port = ipv6Server.address().port;
await new Promise((resolve, reject) => {
  const socket = connect({ host: "::1", port: ipv6Port });
  socket.once("error", reject); socket.once("connect", () => { socket.destroy(); resolve(); });
});

function execute(command, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawnAgentProcess(command, args, { cwd: workspace, env: scrubSecretEnv(process.env) });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("isolation check timed out")); }, 30_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}
const folder = await mkdtemp(join(workspace, "isolation-check-"));
const appProbePath = join(root, `.isolation-${randomUUID()}`);
// mkdtemp is 0700; the explicit shared mode keeps this disposable probe accessible to the agent.
const { chmod } = await import("node:fs/promises");
await chmod(folder, 0o2770);
try {
  const probe = await execute(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import net from 'node:net'; import dns from 'node:dns/promises'; import {spawnSync} from 'node:child_process';
    const socket = (host,port) => new Promise(resolve => { const s=net.connect(port===undefined ? {path:host} : {host,port}); s.setTimeout(1500); s.once('connect',()=>{s.destroy();resolve(true)}); s.once('error',()=>resolve(false)); s.once('timeout',()=>{s.destroy();resolve(false)}); });
    const canRead=p=>{try{fs.readFileSync(p);return true}catch{return false}};
    let appWritable=false; try{fs.writeFileSync(${JSON.stringify(appProbePath)},'test',{flag:'wx'});appWritable=true}catch{}
    const resolver=new dns.Resolver({timeout:750,tries:1});resolver.setServers(['1.1.1.1']);let dnsWorks=false;try{await resolver.resolve4('example.com');dnsWorks=true}catch{}
    const results={unprivileged:process.getuid()!==${process.getuid()} && process.getuid()!==0, botEnvReadable:canRead('/home/user/.raytonebot/env'), botProcReadable:canRead('/proc/${process.pid}/environ'), appWritable, sudoWorks:spawnSync('/usr/bin/sudo',['-n','id','-u']).status===0, botReachable:await socket('127.0.0.1',5188), ipv6Reachable:await socket('::1',${ipv6Port}), externalReachable:await socket('1.1.1.1',443), dnsWorks, dbusReachable:await socket('/run/dbus/system_bus_socket'), varlinkReachable:await socket('/run/systemd/resolve/io.systemd.Resolve'), gatewayReachable:await socket('127.0.0.1',${port}), noNewPrivileges:/NoNewPrivs:\\s+1/.test(fs.readFileSync('/proc/self/status','utf8'))};
    console.log(JSON.stringify(results));
  `]);
  assert.equal(probe.code, 0, "native probe exited successfully");
  const result = JSON.parse(probe.stdout.trim());
  assert.deepEqual(result, { unprivileged: true, botEnvReadable: false, botProcReadable: false, appWritable: false, sudoWorks: false, botReachable: false, ipv6Reachable: false, externalReachable: false, dnsWorks: false, dbusReachable: false, varlinkReachable: false, gatewayReachable: true, noNewPrivileges: true });
  console.log("PASS native UID, private files, read-only app, privilege escalation, direct network/DNS and gateway boundary");
  const worker = async (name, params) => {
    const result = await execute(process.execPath, [join(root, "src/pi/runtime/piToolWorker.ts")], JSON.stringify({ name, id: "isolation-check", params }));
    return result.stdout.trim().split("\n").map(line => JSON.parse(line)).at(-1);
  };
  const denied = await worker("read", { path: "/home/user/.raytonebot/env" });
  assert.ok(denied.error, "Pi read cannot read bot credential file");
  const file = join(folder, "worker.txt");
  assert.ok((await worker("write", { path: file, content: "isolated-worker" })).result);
  const read = await worker("read", { path: file });
  assert.match(JSON.stringify(read.result), /isolated-worker/);
  const edit = await worker("edit", { path: file, edits: [{ oldText: "isolated-worker", newText: "isolated-edited" }] });
  assert.ok(edit.result, edit.error ?? "Pi edit returned no result");
  for (const [name, params, expected] of [["grep", { pattern: "isolated-edited", path: folder }, /isolated-edited/],
    ["find", { pattern: "*.txt", path: folder }, /worker.txt/], ["ls", { path: folder }, /worker.txt/]]) {
    const response = await worker(name, params);
    assert.ok(response.result, response.error ?? `Pi ${name} returned no result`);
    assert.match(JSON.stringify(response.result), expected);
  }
  const bash = await worker("bash", { command: "id -un; awk '/NoNewPrivs/{print $2}' /proc/self/status" });
  assert.match(JSON.stringify(bash.result), /raytone-agent/);
  assert.match(JSON.stringify(bash.result), /1/);
  console.log("PASS all seven Pi tools execute under the isolated identity");
  const packages = await execute("curl", ["--silent", "--show-error", "--max-time", "15", "--noproxy", "", "--proxy", `http://127.0.0.1:${port}`, "-o", "/dev/null", "-w", "%{http_code}", "https://registry.npmjs.org/typescript"]);
  assert.equal(packages.code, 0, "package proxy request completed");
  assert.equal(packages.stdout, "200", "allowed HTTPS package endpoint is reachable through the gateway");
  console.log("PASS allowed package download through checked TLS tunnel");
} finally { await rm(appProbePath, { force: true }).catch(() => {}); await rm(folder, { recursive: true, force: true }); await gateway?.close(); await new Promise(resolve => ipv6Server.close(resolve)); }
