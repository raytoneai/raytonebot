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
export function foldQuietTools(items: readonly AgentUXTimelineItem[], invisible: (item: AgentUXTimelineItem) => boolean, allTools = false): TurnSegment[] {
  if (allTools) {
    const tools = items.filter((item): item is AgentUXToolTimelineItem => item.kind === "tool" && FINAL.has(item.status));
    const ids = new Set(tools.map((tool) => tool.id));
    return items.flatMap((item): TurnSegment[] => ids.has(item.id)
      ? item.id === tools[0]?.id ? [{ kind: "tools", id: `tools:${item.id}`, tools }] : []
      : [{ kind: "item", item }]);
  }
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

/** A compact total with explicit failures and cancellations; individual steps remain in details. */
export function toolRunSummary(tools: readonly AgentUXToolTimelineItem[], locale: AppLocale): string {
  const copy = chatCopy[locale].toolCard.summary;
  if (!tools.length) return "";
  const count = tools.length;
  const parts = [locale === "zh" ? `${count} 项操作` : locale === "ja" ? `${count} 件の操作` : `${count} operation${count === 1 ? "" : "s"}`];
  const failed = tools.filter((tool) => tool.status === "error").length;
  if (failed) parts.push(copy.failed(failed));
  const cancelled = tools.filter((tool) => tool.status === "cancelled").length;
  if (cancelled) parts.push(locale === "zh" ? `${cancelled} 项已取消` : locale === "ja" ? `${cancelled} 件キャンセル` : `${cancelled} cancelled`);
  return parts.join(copy.separator);
}
