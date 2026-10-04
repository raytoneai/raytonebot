import type { AgentUXTimelineItem } from "@agent-ux/render-core";

import type { AvatarState } from "../avatars/avatarMotion";
import { toolAction } from "./toolPresentation.ts";

const ACTIVE_TOOL = new Set(["pending", "args_streaming", "started", "running", "in_progress"]);

/**
 * What the agent's face should be doing, read from the same state the transcript shows:
 * a question or approval waits on the user; a run shows what it is busy with (reading,
 * editing a file, running a command, writing the answer, or still thinking); a finished run
 * shows its outcome for a moment; and a draft in the composer gets an attentive look.
 */
export function avatarActivity(input: {
  running: boolean;
  awaitingUser: boolean;
  /** The outcome of a run that just finished on screen, while it is being shown. */
  outcome?: "success" | "error";
  drafting: boolean;
  timeline: readonly AgentUXTimelineItem[];
}): AvatarState {
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
