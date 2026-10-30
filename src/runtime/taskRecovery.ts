import type { AppLocale } from "../i18n/locales.ts";
import { featureText } from "../i18n/copy/features.ts";
import type { AgentUXEvent } from "@agent-ux/protocol";

export type RecoveryDestination = "providers" | "mcp" | "vault" | "browser";
export type TaskRecovery = { id: string; runId: string; destination: RecoveryDestination };

/** Only error events suggest configuration. Assistant text and tool arguments are not evidence. */
export function taskRecovery(events: readonly AgentUXEvent[]): TaskRecovery | undefined {
  const tools = new Map<string, { name: string; args?: unknown }>();
  const callKey = (event: AgentUXEvent) => `${event.runId}:${event.payload.toolCallId}`;
  for (const event of events) {
    if (event.type === "tool.call.started" && typeof event.payload.name === "string") tools.set(callKey(event), { name: event.payload.name });
    if (event.type === "tool.call.running" && tools.has(callKey(event))) tools.get(callKey(event))!.args = event.payload.args;
  }
  const signature = (tool: { name: string; args?: unknown }) => JSON.stringify([tool.name, tool.args]);
  const resolved = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "run.started") return;
    const call = tools.get(callKey(event));
    if (event.type === "tool.call.result" && call) resolved.add(signature(call));
    if (!event.runId || !["run.error", "tool.call.error"].includes(event.type)) continue;
    if (event.payload.code === "history_load_failed") continue;
    if (event.type === "tool.call.error" && call && resolved.has(signature(call))) continue;
    const message = [event.payload.message, event.payload.userMessage, JSON.stringify(event.payload.error ?? "")].join(" ").slice(0, 16_000);
    const tool = call?.name.replace(/^mcp__raytone__/, "") ?? "";
    const connectionError = /401|403|unauthorized|authentication|api[ _-]?key|token|connect|timed? ?out|switched off|disabled|not found|令牌|连接|停用|未配置/i.test(message);
    const destination: RecoveryDestination | undefined = (/^mcp__/.test(tool) && connectionError || /MCP (server|service|tool)|MCP.*(停用|连接|令牌|未配置)/i.test(message)) ? "mcp"
      : /vault.*(not found|not available|disabled|empty)|(?:no|missing) saved (login|credential)|凭据库.*(未|停|空)/i.test(message) ? "vault"
      : /log[ -]?in (required|first|to continue)|not logged in|sign[ -]?in required|请.*登录|尚未登录/i.test(message) ? "browser"
      : /^browser[_\.]/.test(tool) && connectionError ? "browser"
      : event.type === "run.error" && /api[ _-]?key|model service|模型服务|authentication failed|invalid.*credential|unauthorized|invalid.*model|model.*not found|did not activate the selected model/i.test(message) ? "providers" : undefined;
    if (destination) return { id: event.id ?? `${event.runId}:${event.type}:${event.seq ?? i}`, runId: event.runId, destination };
  }
}

export function recoveryPrompt(prompt: string, accepted: boolean, locale: AppLocale): string {
  if (!accepted) return prompt;
  return (featureText(locale, "Configuration has been checked. Continue the original task. Check completed steps and current state first; do not repeat successful actions or actions with an unconfirmed outcome. Keep the existing approval rules.\n\nOriginal request:\n")) + prompt;
}

export const recoveryDestinationLabel = (destination: RecoveryDestination, locale: AppLocale) => ({
  providers: featureText(locale, "Check model service"), mcp: featureText(locale, "Check MCP connection"),
  vault: featureText(locale, "Manage saved logins"), browser: featureText(locale, "Open browser to sign in"),
})[destination];
