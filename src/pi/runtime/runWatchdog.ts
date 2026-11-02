import { createHash } from "node:crypto";
import type { AgentUXEvent } from "@agent-ux/protocol";

export type WatchdogAlert = { code: "repeated_tool_failure" | "inactive_run"; tool?: string; count?: number; durationMs?: number };
const IDLE_MS = 5 * 60 * 1000, MAX_TOOLS = 128;

/** Observes events only; arguments become an in-memory digest and never enter diagnostics. */
export function createRunWatchdog(options: { enabled(): boolean; waiting(): boolean; alert(value: WatchdogAlert): void }) {
  const tools = new Map<string, { name?: string; fingerprint?: string; running: boolean; excluded?: boolean }>();
  const alerted = new Set<WatchdogAlert["code"]>();
  let lastActivity = Date.now(), previous: string | undefined, failures = 0, disposed = false, overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => { disposed = true; clearTimeout(timer); tools.clear(); previous = undefined; failures = 0; };
  const enabled = () => {
    if (disposed) return false;
    try { if (options.enabled()) return true; } catch { /* Optional diagnostics fail closed. */ }
    dispose(); return false;
  };
  const alert = (value: WatchdogAlert) => {
    if (!enabled() || alerted.has(value.code)) return;
    alerted.add(value.code);
    try { options.alert(value); } catch { /* Diagnostics never affect a run. */ }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!enabled() || alerted.has("inactive_run") || overflow || [...tools.values()].some(tool => tool.running)) return;
    timer = setTimeout(() => {
      if (!enabled()) return;
      let waiting = true;
      try { waiting = options.waiting(); } catch { /* Unknown waiting state is excluded. */ }
      if (waiting) lastActivity = Date.now();
      else alert({ code: "inactive_run", durationMs: Math.max(0, Math.floor(Date.now() - lastActivity)) });
      schedule();
    }, Math.max(1, IDLE_MS - (Date.now() - lastActivity)));
    timer.unref();
  };
  const fingerprint = (args: unknown) => {
    if (args === undefined) return undefined;
    try {
      const text = JSON.stringify(args, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
      if (!text || text.length > 65536) return undefined;
      return createHash("sha256").update(text).digest("hex");
    } catch { return undefined; }
  };
  schedule();
  return {
    observe(event: AgentUXEvent) {
      if (!enabled()) return;
      if (event.type === "run.finished" || event.type === "run.error") { dispose(); return; }
      lastActivity = Date.now();
      const payload = event.payload as Record<string, unknown>;
      const id = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
      if (id && ["tool.call.started", "tool.call.running"].includes(event.type) && !tools.has(id)) {
        if (tools.size >= MAX_TOOLS) { overflow = true; tools.clear(); }
        if (!overflow) tools.set(id, { name: typeof payload.name === "string" && payload.name !== "tool" && /^[a-z][a-z0-9_.:-]{0,127}$/.test(payload.name) ? payload.name : undefined, running: false });
      }
      const tool = id ? tools.get(id) : undefined;
      if (tool && event.type === "tool.call.running") { tool.running = true; if (!tool.excluded) tool.fingerprint = fingerprint(payload.args); }
      if (tool && event.type === "tool.call.awaiting_approval") tool.running = false;
      if (tool && event.type === "tool.call.finished") {
        tools.delete(id!);
        if (payload.status === "success") { previous = undefined; failures = 0; }
        else if (payload.status === "error" && tool.running && tool.name && tool.fingerprint) {
          const key = `${tool.name}:${tool.fingerprint}`;
          failures = previous === key ? failures + 1 : 1; previous = key;
          if (failures >= 4) alert({ code: "repeated_tool_failure", tool: tool.name, count: failures });
        } else { previous = undefined; failures = 0; }
      }
      schedule();
    },
    excludeTool(id: string) {
      if (disposed || overflow) return;
      if (!tools.has(id)) {
        if (tools.size >= MAX_TOOLS) { overflow = true; tools.clear(); clearTimeout(timer); return; }
        tools.set(id, { running: false, excluded: true });
      }
      const tool = tools.get(id);
      if (tool) { tool.excluded = true; tool.fingerprint = undefined; }
    },
    dispose,
  };
}
