import type { AgentUXTimelineItem, AgentUXToolTimelineItem } from "@agent-ux/render-core";
import { chatCopy } from "../i18n/copy/chat.ts";
import type { AppLocale } from "../i18n/locales.ts";
import { resolveToolConcept } from "./eventNormalizer.ts";

/**
 * A finished turn folds its quiet steps — reads, searches, checks and commands — into one line,
 * the way Grok Bot shows only the answer. File edits stay (their file rows are the result), and
 * so does anything still running, waiting on the user, or shown as a card of its own.
 */
type QuietKind = "run-command" | "read-file" | "read-image" | "search" | "validate" | "fetch";
const QUIET = new Set<string>(["run-command", "read-file", "read-image", "search", "validate", "fetch"]);
// Engine tool names the shared concept table does not resolve (Pi's ls, Claude Code's Web*).
const LOCAL: Record<string, QuietKind> = { ls: "search", webfetch: "fetch", websearch: "fetch" };
const FINAL = new Set(["success", "error", "cancelled"]);

function quietKind(tool: AgentUXToolTimelineItem): QuietKind | undefined {
  const concept = resolveToolConcept(tool.name) ?? LOCAL[String(tool.name ?? "").toLowerCase()];
  return concept && QUIET.has(concept) ? concept as QuietKind : undefined;
}

export const isQuietTool = (tool: AgentUXToolTimelineItem) => Boolean(quietKind(tool) && FINAL.has(tool.status));

export type TurnSegment = { kind: "item"; item: AgentUXTimelineItem } | { kind: "tools"; id: string; tools: AgentUXToolTimelineItem[] };

/** Runs of quiet tools become one segment; `invisible` items (rendered as nothing) do not break a run. */
export function foldQuietTools(items: readonly AgentUXTimelineItem[], invisible: (item: AgentUXTimelineItem) => boolean): TurnSegment[] {
  const out: TurnSegment[] = [];
  let run: AgentUXToolTimelineItem[] = [];
  let held: AgentUXTimelineItem[] = [];
  const flush = () => {
    if (run.length) out.push({ kind: "tools", id: `tools:${run[0].id}`, tools: run });
    out.push(...held.map((item): TurnSegment => ({ kind: "item", item })));
    run = [];
    held = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && isQuietTool(item)) {
      run.push(item);
      continue;
    }
    if (run.length && invisible(item)) {
      held.push(item);
      continue;
    }
    flush();
    out.push({ kind: "item", item });
  }
  flush();
  return out;
}

/** "运行了 2 条命令 · 读取了 1 个文件 · 1 个失败", in the order the kinds first appeared. */
export function toolRunSummary(tools: readonly AgentUXToolTimelineItem[], locale: AppLocale): string {
  const copy = chatCopy[locale].toolCard.summary;
  const counts = new Map<QuietKind, number>();
  for (const tool of tools) {
    const kind = quietKind(tool);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const label: Record<QuietKind, (n: number) => string> = { "run-command": copy.runCommand, "read-file": copy.readFile,
    "read-image": copy.readImage, search: copy.search, validate: copy.validate, fetch: copy.fetch };
  const parts = [...counts].map(([kind, n]) => label[kind](n));
  const failed = tools.filter((tool) => tool.status === "error").length;
  if (failed) parts.push(copy.failed(failed));
  const text = parts.join(copy.separator);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
