import { execFileSync, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { scrubSecretEnv } from "./childEnv.ts";

export function agentIsolationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAYTONEBOT_SANDBOX === "1";
}

/** Sandbox mode is fail-closed: deployment, not an agent-controlled directory, owns this marker. */
export function requireAgentIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (!agentIsolationEnabled(env)) return;
  if (process.platform !== "linux" || env.RAYTONEBOT_ISOLATION_READY !== "1"
    || env.RAYTONEBOT_AGENT_USER !== "raytone-agent" || env.RAYTONEBOT_AGENT_HOME !== "/home/raytone-agent") {
    throw new Error("Agent isolation is not configured; run setup_isolation.py before starting the sandbox.");
  }
  const markerStat = lstatSync("/etc/raytonebot-isolation.json");
  if (!markerStat.isFile() || markerStat.uid !== 0 || (markerStat.mode & 0o022) !== 0) throw new Error("Agent isolation marker is not root-protected.");
  const marker = JSON.parse(readFileSync("/etc/raytonebot-isolation.json", "utf8"));
  if (marker.user !== env.RAYTONEBOT_AGENT_USER || marker.port !== gatewayPort(env) || marker.network !== "nft-dual-stack") {
    throw new Error("Agent isolation configuration does not match the installed firewall.");
  }
  for (const path of ["/run/dbus", "/run/systemd"]) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    const acl = execFileSync("/usr/bin/getfacl", ["-cpn", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!stat.isDirectory() || stat.uid === marker.uid || !acl.split("\n").includes(`user:${marker.uid}:---`)) {
      throw new Error("System broker isolation was reset; rerun setup_isolation.py before starting agents.");
    }
  }
}

export function gatewayPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.RAYTONEBOT_GATEWAY_PORT ?? 5190);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid agent gateway port.");
  return port;
}

/** Only temporary model credentials may be deliberately added by the caller after scrubbing. */
export function agentEnvironment(env: NodeJS.ProcessEnv, hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!agentIsolationEnabled(hostEnv)) return { ...env,
    NO_PROXY: [env.NO_PROXY ?? env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(","),
    no_proxy: [env.no_proxy ?? env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
  };
  requireAgentIsolation(hostEnv);
  const proxy = `http://127.0.0.1:${gatewayPort(hostEnv)}`;
  const isolatedHome = env.HOME?.startsWith("/tmp/raytone-codex-") ? env.HOME : hostEnv.RAYTONEBOT_AGENT_HOME;
  const next = { ...env, HOME: isolatedHome, USER: "raytone-agent", LOGNAME: "raytone-agent",
    PI_CODING_AGENT_DIR: `${hostEnv.RAYTONEBOT_AGENT_HOME}/.pi`,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
  // Never load bot-side code through inherited runtime injection or search paths.
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV"]) delete (next as NodeJS.ProcessEnv)[key];
  return next;
}

/** Hand off a fresh, still bot-owned Codex home only after the caller has populated it. */
export function prepareAgentDirectory(path: string): void {
  if (!agentIsolationEnabled()) return;
  requireAgentIsolation();
  const stat = lstatSync(path);
  if (!/^\/tmp\/raytone-codex-[^/]+$/.test(path) || !stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Expected a private, freshly created Codex home.");
  }
  execFileSync("/usr/bin/sudo", ["-n", "chown", "-R", "--no-dereference", "raytone-agent:user", "--", path]);
  execFileSync("/usr/bin/sudo", ["-n", "chmod", "g+rwx", "--", path]);
}

export function cleanupAgentDirectory(path: string): void {
  if (!agentIsolationEnabled()) throw new Error("Use ordinary filesystem cleanup outside isolation.");
  requireAgentIsolation();
  if (!/^\/tmp\/raytone-codex-[^/]+$/.test(path)) throw new Error("Invalid isolated Codex home.");
  // rm runs as the agent, never as root; a replaced symlink cannot affect bot-owned data.
  execFileSync("/usr/bin/sudo", ["-n", "-u", "raytone-agent", "--", "/usr/bin/rm", "-rf", "--", path]);
}

// Reads KEY=value lines from stdin up to a blank line, then execs the real command on the rest of
// stdin. Values never reach argv, so /proc/*/cmdline and sudo's log do not see lease tokens.
export const ENV_PREAMBLE = 'while IFS= read -r line && [ -n "$line" ]; do export "$line"; done; exec "$@"';

export function agentCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const childEnv = agentEnvironment(env);
  if (!agentIsolationEnabled()) return { command, args: [...args], env: childEnv, preamble: "" };
  return {
    command: "/usr/bin/sudo",
    args: ["-n", "-u", "raytone-agent", "--", "/usr/bin/setpriv", "--no-new-privs", "/usr/bin/env", "-i",
      "/bin/sh", "-c", ENV_PREAMBLE, "sh", command, ...args],
    env: scrubSecretEnv(process.env),
    preamble: envPreamble(childEnv),
  };
}

export function envPreamble(env: NodeJS.ProcessEnv): string {
  let text = "";
  for (const [key, value] of Object.entries(env)) {
    // sh cannot export these; the old `env -i` argv form could, but none are deliberate inputs.
    if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\n\0]/.test(value)) continue;
    text += `${key}=${value}\n`;
  }
  return `${text}\n`;
}

export function spawnAgentProcess(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & { env: NodeJS.ProcessEnv }) {
  const launch = agentCommand(command, args, options.env);
  const child = spawn(launch.command, launch.args, { ...options, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
  if (launch.preamble) child.stdin.write(launch.preamble);
  return child;
}
