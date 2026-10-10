import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";

import type { AvatarState } from "../avatars/avatarMotion";
import { toolAction } from "./toolPresentation.ts";

const ACTIVE_TOOL = new Set(["pending", "args_streaming", "started", "running", "in_progress"]);

/**
 * What the agent's face should be doing, read from the same state the transcript shows:
 * a question or approval waits on the user; a run shows what it is busy with (reading,
 * editing a file, running a command, writing the answer, or still thinking); a finished run
 * shows its outcome for a moment; and a draft in the composer gets an attentive look. A lost
 * connection to the host outranks everything: nothing on screen is current until it is back.
 */
export function avatarActivity(input: {
  running: boolean;
  awaitingUser: boolean;
  /** The outcome of a run that just finished on screen, while it is being shown. */
  outcome?: RunOutcomeFace;
  /** The conversation's stream to the host failed and is not reconnected. */
  connectionLost?: boolean;
  drafting: boolean;
  timeline: readonly AgentUXTimelineItem[];
}): AvatarState {
  if (input.connectionLost) return "fault";
  if (input.awaitingUser) return "asking";
  if (input.running) {
    const last = [...input.timeline].reverse().find((item) => item.kind !== "step");
    if (last?.kind === "tool" && ACTIVE_TOOL.has(last.status)) {
      const action = toolAction(last);
      if (action === "edit-file" || action === "modify-file") return "editing";
      if (action === "read-file" || action === "read-image" || action === "search") return "reading";
      return "working";
    }
    if (last?.kind === "message" && last.role === "assistant" && last.text) return "writing";
    return "thinking";
  }
  if (input.outcome) return input.outcome;
  return input.drafting ? "listening" : "idle";
}

export type RunOutcomeFace = "success" | "error" | "fault";

/**
 * How the last run ended, as a face: a run that finished but failed is the task's failure
 * ("error"); `run.error` is the engine, model or service failing under it ("fault"). A stop
 * shows nothing.
 */
export function runOutcomeFace(events: readonly AgentUXEvent[]): RunOutcomeFace | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "run.error") return "fault";
    if (event.type === "run.finished") {
      const status = String((event.payload as { status?: string }).status ?? "success");
      return status === "success" ? "success" : status === "cancelled" ? undefined : "error";
    }
  }
  return undefined;
}
