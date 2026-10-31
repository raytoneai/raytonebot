import type { AgentUXTimelineItem } from "@agent-ux/render-core";

export type ConversationEntry =
  | { kind: "user"; id: string; prompt: string }
  | { kind: "item"; item: AgentUXTimelineItem };

/** Insert prompts by assistant-message index; every assistant message consumes one history slot. */
export function buildConversationEntries(
  timeline: readonly AgentUXTimelineItem[],
  promptHistory: readonly string[] | undefined,
  previewPrompt: string,
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];

  if (promptHistory?.length) {
    let assistantMessageIndex = 0;
    for (const item of timeline) {
      if (item.kind === "message" && item.role === "assistant") {
        const prompt = promptHistory[assistantMessageIndex];
        assistantMessageIndex += 1;
        if (prompt) {
          entries.push({ kind: "user", id: `prompt:${item.id}`, prompt });
        }
      }
      entries.push({ kind: "item", item });
    }
    return entries;
  }

  if (previewPrompt.trim()) {
    entries.push({ kind: "user", id: "preview-prompt", prompt: previewPrompt });
  }
  for (const item of timeline) {
    entries.push({ kind: "item", item });
  }
  return entries;
}
