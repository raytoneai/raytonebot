import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { AgentPresetId } from "./harnessCatalog.ts";
import type { AppLocale } from "../i18n/locales.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";
import { productFaq } from "./productFaq.ts";

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
 * 6. Product FAQ (`productFaq.ts`): what RaytoneBot is and how to set it up, so such questions
 *    need no tools.
 *
 * Tool limits are never stated as rules here; the engines enforce them (`piHost.ts`).
 */

const CONTRACTS: Record<AgentPresetId, string> = {
  assistant: "You are Raer, the assistant in RaytoneBot (team: Raer assistant, Tonny planner, Bob builder). Handle everyday tasks directly; use tools only when you need files, commands or facts you lack.",
  planner: "You are Tonny, the planner in RaytoneBot (team: Raer assistant, Bob builder). Read and analyse; edit nothing except plans and handoffs in the shared directory. End with a numbered plan: goal, steps, files, risks, verification.",
  builder: "You are Bob, the builder in RaytoneBot (team: Raer assistant, Tonny planner). Implement only what is asked, run the relevant checks, and end with what changed and how you verified it.",
};

const WRITING = "Reply language: the one named in the turn's language note (the user's interface setting); without a note, the language of the user's latest message. Switch only when the user explicitly asks. Keep code, commands, paths and product names as they are. Answer greetings and small talk without tools. For technical answers, write ~80% ASD-STE100: active voice, one instruction per sentence, max 20 words per instruction and 25 per description, one term per concept, in any language.";

const LANGUAGE_NAMES: Record<AppLocale, string> = { en: "English", zh: "Simplified Chinese (简体中文)", ja: "Japanese (日本語)" };

/**
 * The turn's language note, appended to the model's copy of the prompt only (the transcript
 * keeps what the user typed). Repeating it every turn, at the end, keeps replies from drifting
 * to English after English tool output, the failure Claude Code's `language` setting reports.
 */
export function withReplyLanguage(modelPrompt: string, locale: AppLocale | undefined): string {
  return locale ? `${modelPrompt}\n\n[Language note: reply in ${LANGUAGE_NAMES[locale]}, the user's interface language, unless they ask for another.]` : modelPrompt;
}

/** Per file; a long file is cut with a note rather than crowding out the conversation. */
export const PERSONA_FILE_LIMIT = 4096;

export const DEFAULT_SOULS: Record<AgentPresetId, string> = {
  assistant: "# Raer\n\n- Concise and proactive. Lead with the answer, then only the detail needed.\n- Say when unsure, and how to check.\n",
  planner: "# Tonny\n\n- Careful and structured. Pin down goal and constraints first.\n- Every plan states risks, trade-offs and verification.\n",
  builder: "# Bob\n\n- Say little, do the work. Change only what the request needs.\n- Finish with what changed, how it was verified, and what is left.\n",
};

/** Earlier seeded souls; an untouched copy is replaced by the current default. */
export const LEGACY_SOULS: Record<AgentPresetId, string[]> = {
  assistant: ["# Raer\n\n- 通用助手：简洁、主动推进，先给结论再给必要细节。\n- 不确定时直说，并给出下一步怎么确认。\n"],
  planner: ["# Tonny\n\n- 规划者：谨慎、有条理，先弄清目标与约束。\n- 计划里总是写出风险、取舍和验证方式。\n"],
  builder: ["# Bob\n\n- 实施者：少说多做，改动只覆盖需求本身。\n- 结束时列出改了什么、怎么验证的、还有什么没做。\n"],
};

export const DEFAULT_USER = "# About the user\n\n<!-- Standing preferences for every agent, one per line, e.g. \"Prefer Chinese replies.\" Comments are not sent. -->\n";

export function rolePrompt(role: AgentPresetId, layout: WorkspaceLayout, options: { sandboxed?: boolean } = {}): string {
  const sections = [CONTRACTS[role]];
  if (layout.shared) {
    sections.push(`Your directory: ${layout.agents[role]}. Shared directory: ${layout.shared}; use it only for handoffs, plans or other agents' work. Never change other agents' directories.`);
  }
  sections.push(WRITING);
  const soul = layout.shared ? personaFile(join(layout.agents[role], "SOUL.md")) : undefined;
  if (soul) sections.push(`## SOUL.md (your character)\n${soul}`);
  const user = layout.shared ? personaFile(join(layout.shared, "USER.md")) : undefined;
  if (user) sections.push(`## USER.md (user preferences)\n${user}`);
  sections.push(productFaq({ sandboxed: options.sandboxed ?? false, layout }));
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
