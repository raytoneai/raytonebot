import type { AgentUXEvent } from "@agent-ux/protocol";
import type { ChannelSetupState } from "../pi/imChannels/types.ts";

export type PendingChannelSetup = ChannelSetupState & { requestId: string };

/** The open `connect_channel` card, if any: its latest stage, until resolved or the run ends. */
export function pendingChannelSetup(events: readonly AgentUXEvent[]): PendingChannelSetup | undefined {
  const pending = new Map<string, PendingChannelSetup>();
  for (const event of events) {
    if (["run.started", "run.finished", "run.error"].includes(event.type)) pending.clear();
    const payload = event.payload as Record<string, any>;
    if (event.type === "run.awaiting_input" && payload.channelSetup) pending.set(payload.requestId, { ...payload.channelSetup, requestId: payload.requestId });
    if (event.type === "tool.call.progress" && payload.inputRequestId) pending.delete(payload.inputRequestId);
  }
  return [...pending.values()].at(-1);
}
