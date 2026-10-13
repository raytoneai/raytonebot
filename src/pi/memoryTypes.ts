/** Cross-conversation memory as the settings page sees it (ADR-038). Shared by server and browser; no Node imports. */

import type { AgentPresetId } from "./harnessCatalog.ts";

export type MemoryView = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Saved by an agent in a conversation, or added by hand in Settings when absent. */
  source?: { conversationId: string; agent: AgentPresetId };
};

export type MemoryState = { enabled: boolean; memories: MemoryView[] };

export const MEMORY_TEXT_LIMIT = 300;
export const MEMORY_COUNT_LIMIT = 100;
