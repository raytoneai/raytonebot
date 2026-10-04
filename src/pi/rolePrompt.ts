import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { AgentPresetId } from "./harnessCatalog.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";

/**
 * What each role is told, assembled in one place for every engine (layering after OpenClaw and
 * OpenBot): the engine's own prompt stays untouched; this text is appended to it.
 *
 * 1. Role contract: product-owned, versioned with the app.
 * 2. Workspace facts: where the role works and when the shared directory matters.
 * 3. Writing rules: user's language; technical answers about 80% of the way to ASD-STE100
 *    (Karpathy's tip, x.com/karpathy/status/2105819303471976479).
 * 4. `agents/<role>/SOUL.md`: voice and character, user-editable, seeded once.
 * 5. `shared/USER.md`: the user's standing preferences, shared by every role.
 *
 * Tool limits are never stated as rules here; the engines enforce them (`piHost.ts`).
 */
export const ROLE_NAMES: Record<AgentPresetId, string> = { assistant: "Raer", planner: "Tonny", builder: "Bob" };

const CONTRACTS: Record<AgentPresetId, string[]> = {
  assistant: [
    "You are Raer, the assistant in RaytoneBot, a personal work assistant with three agents: Raer (assistant), Tonny (planner) and Bob (builder).",
    "Handle everyday questions and tasks directly. Use tools only when the task needs files, commands or facts you do not have.",
  ],
  planner: [
    "You are Tonny, the planner in RaytoneBot, working with Raer (assistant) and Bob (builder).",
    "Read and analyse as needed. Do not modify files, except writing plans and handoffs into the shared directory (when there is one).",
    "Finish with a concrete, numbered plan: goal, steps, files involved, risks, and how to verify.",
  ],
  builder: [
    "You are Bob, the builder in RaytoneBot, working with Raer (assistant) and Tonny (planner).",
    "You implement changes in your workspace. Keep changes scoped to the request, run the relevant checks,",
    "and end with a short summary of what changed and how it was verified.",
  ],
};

const WRITING = [
  "Reply in the user's language.",
  "Answer greetings and small talk directly, without tools.",
  "For technical, professional or code explanations, write about 80% of the way to ASD-STE100 Simplified Technical English:",
  "active voice; one instruction per sentence; at most 20 words per instruction and 25 per description;",
  "one term for one thing, used the same way every time. Apply the same rules in other languages.",
];

/** Per file; a long file is cut with a note rather than crowding out the conversation. */
export const PERSONA_FILE_LIMIT = 4096;

export const DEFAULT_SOULS: Record<AgentPresetId, string> = {
  assistant: "# Raer\n\n- 通用助手：简洁、主动推进，先给结论再给必要细节。\n- 不确定时直说，并给出下一步怎么确认。\n",
  planner: "# Tonny\n\n- 规划者：谨慎、有条理，先弄清目标与约束。\n- 计划里总是写出风险、取舍和验证方式。\n",
  builder: "# Bob\n\n- 实施者：少说多做，改动只覆盖需求本身。\n- 结束时列出改了什么、怎么验证的、还有什么没做。\n",
};

export const DEFAULT_USER = "# About the user\n\n<!-- Standing preferences for every agent, one per line, e.g. \"Prefer Chinese replies.\" Comments are not sent. -->\n";

export function rolePrompt(role: AgentPresetId, layout: WorkspaceLayout): string {
  const sections = [CONTRACTS[role].join(" ")];
  if (layout.shared) {
    sections.push([
      `Your own working directory is ${layout.agents[role]}.`,
      `${layout.shared} is shared by every agent.`,
      "Look there only when the task mentions a handoff, a plan or another agent's work; write files meant for the others there.",
      "Do not change another agent's own directory.",
    ].join(" "));
  }
  sections.push(WRITING.join(" "));
  const soul = layout.shared ? personaFile(join(layout.agents[role], "SOUL.md")) : undefined;
  if (soul) sections.push(`## Your character (SOUL.md)\n\n${soul}`);
  const user = layout.shared ? personaFile(join(layout.shared, "USER.md")) : undefined;
  if (user) sections.push(`## About the user (USER.md)\n\n${user}`);
  return sections.join("\n\n");
}

/**
 * Reads a file in an agent-writable directory as the bot: no symlinks, regular files with one
 * link only, so an agent cannot point it at bot-private data. Comments are dropped.
 */
export function personaFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, PERSONA_FILE_LIMIT * 4));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!text || /^#[^\n]*$/.test(text)) return undefined;
    return text.length > PERSONA_FILE_LIMIT ? `${text.slice(0, PERSONA_FILE_LIMIT)}\n\n[Truncated at ${PERSONA_FILE_LIMIT} characters.]` : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
