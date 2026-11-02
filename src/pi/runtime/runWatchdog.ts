import { createHash } from "node:crypto";
import { types } from "node:util";
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
      let entries = 2048, characters = 65536;
      const ancestors = new Set<object>();
      const reject = (): never => { throw new Error("watchdog_fingerprint_limit"); };
      const spend = (amount: number) => { if (amount > characters) reject(); characters -= amount; };
      const copy = (value: unknown, depth: number): unknown => {
        if (depth > 16) reject();
        if (typeof value === "string") { spend(value.length + 2); return value; }
        if (value === null || typeof value === "boolean") { spend(5); return value; }
        if (typeof value === "number" && Number.isFinite(value)) { spend(24); return value; }
        if (typeof value !== "object" || !value || types.isProxy(value) || ancestors.has(value)) return reject();
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) reject();
        ancestors.add(value); spend(2);
        let result: unknown;
        if (array) {
          if (value.length > entries) reject();
          entries -= value.length; spend(value.length);
          const items: unknown[] = [];
          for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, index);
            if (!descriptor || !("value" in descriptor)) return reject();
            items.push(copy(descriptor.value, depth + 1));
          }
          result = items;
        } else {
          const fields = new Map<string, unknown>();
          // Stop collecting before sorting; never copy an unbounded Object.keys array.
          for (const key in value) {
            if (!Object.hasOwn(value, key)) continue;
            if (--entries < 0) reject();
            spend(key.length + 4);
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor)) return reject();
            fields.set(key, descriptor.value);
          }
          const object = Object.create(null) as Record<string, unknown>;
          for (const key of [...fields.keys()].sort()) object[key] = copy(fields.get(key), depth + 1);
          result = object;
        }
        ancestors.delete(value);
        return result;
      };
      const text = JSON.stringify(copy(args, 0));
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
