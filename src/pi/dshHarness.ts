import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliCommand, runCliProcess, type CliRunBase, type ClaudePermissionRequest } from "./cliHarness.ts";
import { createDshProtocol } from "./dshProtocol.ts";
import { scrubSecretEnv } from "./runtime/childEnv.ts";
import { agentIsolationEnabled } from "./runtime/agentProcess.ts";
import { WEB_TOOL_SPECS } from "./webAccess.ts";
import { userInputTool } from "./userInputTool.ts";
import { planTool } from "./planTool.ts";
import type { HostToolResult, HostToolSpec } from "./mcpServers.ts";

export const DSH_VERSION = "0.2.1-rc.2";
export type DshRunOptions = CliRunBase & {
  home: string;
  systemPrompt: string;
  provider: { baseUrl: string; apiKey: string; model: string };
  onPermission(request: ClaudePermissionRequest): Promise<true | string>;
  onAccepted?(): void;
};

/** Resolve the existing CLI installation, without adding its dependencies to the web app. */
export function dshInstallation(env: NodeJS.ProcessEnv = process.env): string {
  const command = cliCommand("dsh", env);
  const binary = isAbsolute(command) ? command : (env.PATH ?? "").split(delimiter).map(path => join(path, command)).find(path => existsSync(path));
  if (!binary) throw new Error(`DeepSeek Harness is not installed. Install @deepseek-ai/dsh@${DSH_VERSION}.`);
  const anchor = join(dirname(dirname(realpathSync(binary))), "package.json");
  const pkg = JSON.parse(readFileSync(anchor, "utf8"));
  if (pkg.name !== "@deepseek-ai/dsh" || pkg.version !== DSH_VERSION) throw new Error(`This adapter requires @deepseek-ai/dsh@${DSH_VERSION}; found ${String(pkg.version)}.`);
  return anchor;
}

/** A complete, host-owned overlay. No personal profiles, credentials, telemetry or autonomous work. */
export function dshPatch(options: Pick<DshRunOptions, "cwd" | "home" | "provider">, socketPath: string, specs: HostToolSpec[], mcpClientModule?: string) {
  const disabled = ["hmr", "plugin-manager", "tool-plugin-manager", "config-editor", "settings", "credentials", "authorization",
    "deepseek-account", "llm-deepseek-account", "llm-pi-ai", "session-log-deepseek", "plugin-package-inventory-deepseek",
    "otel", "session-telemetry-otel", "ptc-runtime", "workflow-ptc", "tool-workflow", "subagent-spawn-in-process", "subagent-fork-in-process",
    "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents", "tool-web", "web-search-deepseek",
    "web-deepseek-api", "web-fetch-http", "goal-round-driver", "tool-goal", "plan-mode", "skill-filesystem", "tool-skill",
    "agent-instructions", "tool-jobs", "jobs", "tool-pwsh", "tool-ask-user", "tool-todo", "tool-str-replace-editor", "tool-working-directory"];
  return [
    ...disabled.map(id => ({ id, disabled: true })),
    { id: "tools", config: { mode: "native" } },
    { id: "approval", config: { policy: "ask" } },
    { id: "permission", config: { defaultPreset: "raytone-workspace", presets: { "raytone-workspace": { sandbox: "workspace-write", approval: "ask" } } } },
    { id: "sandbox-policy", config: { mode: "workspace-write", workspaceRoot: options.cwd } },
    { id: "tool-bash", config: { enableRunInBackground: false, promoteOnTimeout: false } },
    { id: "bash-sandbox", config: { timeoutMs: 120_000, maxTimeoutMs: 600_000, graceMs: 1_000 } },
    { id: "llm-deepseek", config: { apiKeyEnv: "RAYTONE_DSH_MODEL_TOKEN", baseURL: options.provider.baseUrl } },
    { id: "agent-default-model", config: { provider: "deepseek-official", model: options.provider.model } },
    { id: "session-persistence-jsonl", config: { root: join(options.home, "sessions") } },
    { id: "attachment-local", config: { dshHome: options.home } },
    { id: "acp", inject: ["acpAppStartup", "raytoneBridge"], config: { provider: "deepseek-official", model: options.provider.model } },
    { insert: [{ id: "raytone-bridge", name: fileURLToPath(new URL("./runtime/dshPlugin.mjs", import.meta.url)),
      config: { socketPath, tools: specs, mcpClientModule } }] },
  ];
}

export async function runDsh(options: DshRunOptions): Promise<void> {
  if (options.signal.aborted) return;
  if (agentIsolationEnabled()) throw new Error("DSH is available for local testing; sandbox support requires separate Linux validation.");
  const anchor = dshInstallation();
  const questions = options.onUserInput ? userInputTool(options.onUserInput) : undefined;
  const specs: HostToolSpec[] = [...options.webTools ? WEB_TOOL_SPECS : [], ...options.mcpTools?.specs ?? [], ...options.hostTools?.specs ?? [],
    { name: planTool.name, description: planTool.description, inputSchema: planTool.parameters },
    ...questions ? [{ name: questions.name, description: questions.description, inputSchema: questions.parameters }] : []];
  if (new Set(specs.map(spec => spec.name)).size !== specs.length) throw new Error("Duplicate DSH host tool name.");
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(tmpdir(), "rtb-dsh-"));
  const socketPath = join(temp, "host.sock");
  const protocol = createDshProtocol({ ...options, prompt: `[RaytoneBot instructions]\n${options.systemPrompt}\n\n${options.prompt}`,
    userInputTools: ["ask_user", "update_plan"] });
  const sockets = new Set<Socket>();
  const active = new Set<Promise<void>>();
  const controls = new Set<AbortController>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    let text = "", dispatched = false;
    const control = new AbortController();
    controls.add(control);
    const signal = AbortSignal.any([options.signal, control.signal]);
    socket.on("close", () => { sockets.delete(socket); controls.delete(control); control.abort(); });
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (dispatched) return;
      text += chunk;
      if (Buffer.byteLength(text) > 1024 * 1024) { socket.destroy(); return; }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      dispatched = true;
      const work = (async () => {
        let result: HostToolResult;
        try {
          const request = JSON.parse(text.slice(0, newline));
          if (!specs.some(spec => spec.name === request.name)
            || !protocol.takeAuthorization(request.callId, request.name, request.args, request.sessionId)) throw new Error("Unapproved host tool call.");
          if (request.name === "ask_user" && questions) {
            const value = await questions.execute(request.callId, request.args, signal, undefined, {} as never);
            result = { text: value.content.filter(c => c.type === "text").map(c => c.text).join("\n"), isError: false };
          } else if (request.name === "update_plan") {
            const value = await planTool.execute(request.callId, request.args, signal, undefined, {} as never);
            options.emit({ type: "plan_update", ...value.details });
            result = { text: "Plan updated.", isError: false };
          } else {
            const toolkit = [options.hostTools, options.mcpTools].find(set => set?.specs.some(spec => spec.name === request.name));
            if (toolkit) result = await toolkit.run(request.name, request.args, signal);
            else if (options.webTools && WEB_TOOL_SPECS.some(spec => spec.name === request.name)) result = await options.webTools.run(request.name, request.args, signal);
            else throw new Error("Unknown host tool.");
          }
        } catch (error) { result = { text: error instanceof Error ? error.message : "Host tool failed.", isError: true }; }
        if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`);
      })();
      active.add(work);
      void work.finally(() => active.delete(work));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    const patch = join(temp, "profile.json");
    const mcpClientModule = createRequire(anchor).resolve("@deepseek-ai/dsh-mcp-client");
    writeFileSync(patch, JSON.stringify(dshPatch(options, socketPath, specs, mcpClientModule)), { mode: 0o600 });
    const env = scrubSecretEnv(process.env);
    for (const key of Object.keys(env)) if (/^(DSH_|DEEPSEEK_|RAYTONE_|RAYTONEBOT_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$)/.test(key)) delete env[key];
    Object.assign(env, { HOME: temp, DSH_HOME: join(temp, ".dsh"), DSH_AGENTS_HOME: join(temp, ".agents"),
      RAYTONE_DSH_MODEL_TOKEN: options.provider.apiKey });
    try {
      await runCliProcess({ label: "DeepSeek Harness", command: process.execPath,
        args: [fileURLToPath(new URL("./runtime/dshLauncher.mjs", import.meta.url)), anchor, patch], cwd: options.cwd, env,
        signal: options.signal, stdinLines: [protocol.initialize], isFinished: () => protocol.finished,
        onLine: (line, stdin) => protocol.push(line, message => { if (stdin.writable && !("destroyed" in stdin && stdin.destroyed)) stdin.write(`${JSON.stringify(message)}\n`); }),
        onAbort: stdin => protocol.cancel(message => { if (stdin.writable && !("destroyed" in stdin && stdin.destroyed)) stdin.write(`${JSON.stringify(message)}\n`); }),
      });
    } catch (error) {
      if (!options.signal.aborted) throw new Error((protocol.failure ?? (error instanceof Error ? error.message : String(error))).replaceAll(options.provider.apiKey, "[model lease]"));
    }
    if (protocol.failure && !options.signal.aborted) throw new Error(protocol.failure.replaceAll(options.provider.apiKey, "[model lease]"));
  } finally {
    for (const control of controls) control.abort();
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...active]);
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
}
