import type { AgentUXToolTimelineItem } from "@agent-ux/render-core";

import { resolveToolConcept } from "./eventNormalizer.ts";

/**
 * An HTML file being written right now, read from the write call's streaming arguments, so
 * the output panel can show the page taking shape (after Open Intelligent UI's streaming
 * preview, ADR-035). Edits and patches are left out: a fragment of a diff is not a page.
 */
export type LiveHtmlWrite = { toolCallId: string; path: string; title: string; html: string; status: string };

const LIVE_STATUSES = new Set(["args_streaming", "awaiting_approval", "running"]);
const PATH_KEYS = ["path", "file_path", "file", "filename"];

export function liveHtmlWrite(timeline: readonly { kind: string }[]): LiveHtmlWrite | undefined {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind !== "tool") continue;
    const tool = item as AgentUXToolTimelineItem;
    if (!LIVE_STATUSES.has(tool.status) || resolveToolConcept(tool.name) !== "write-file") continue;
    const args = tool.args && typeof tool.args === "object" ? tool.args as Record<string, unknown> : undefined;
    const text = tool.argsText ?? "";
    const path = PATH_KEYS.map((key) => typeof args?.[key] === "string" ? args[key] as string : partialJsonString(text, key, true)).find(Boolean);
    if (!path || !/\.html?$/i.test(path)) return undefined;
    const html = typeof args?.content === "string" ? args.content : partialJsonString(text, "content") ?? "";
    return { toolCallId: tool.id, path, title: path.split("/").filter(Boolean).pop() ?? path, html, status: tool.status };
  }
  return undefined;
}

/**
 * HTML files an edit just finished in this run (Codex `file_change`, Claude Edit), and writes
 * that carried no content to stream (Codex's single-file add): the saved file opens when the
 * call succeeds. Writes with content open through the live preview instead. Only calls of a run
 * this page is following (`live`) that were not already done in `previous`; restored history,
 * where every call arrives already done, opens nothing.
 */
export function finishedHtmlEdits(previous: readonly { kind: string; id?: string }[], timeline: readonly { kind: string; id?: string }[], live: (toolId: string) => boolean): { path: string; title: string; toolCallId: string }[] {
  const before = new Map(previous.filter((item) => item.kind === "tool").map((item) => [item.id, (item as AgentUXToolTimelineItem).status]));
  const files: { path: string; title: string; toolCallId: string }[] = [];
  for (const item of timeline) {
    if (item.kind !== "tool") continue;
    const tool = item as AgentUXToolTimelineItem;
    if (tool.status !== "success") continue;
    const args = tool.args && typeof tool.args === "object" ? tool.args as Record<string, unknown> : {};
    const concept = resolveToolConcept(tool.name);
    if (concept !== "edit-file" && !(concept === "write-file" && typeof args.content !== "string")) continue;
    if (before.get(tool.id) === "success" || !live(tool.id)) continue;
    // Codex lists every file of a patch in `changes`; `path` is only the first.
    const changes = Array.isArray(args.changes) ? args.changes.filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === "object") : [];
    const paths = changes.length
      ? changes.filter((change) => change.kind !== "delete").map((change) => typeof change.move_path === "string" ? change.move_path : change.path)
      : [PATH_KEYS.map((key) => args[key]).find((value) => typeof value === "string")];
    for (const path of new Set(paths)) {
      if (typeof path === "string" && /\.html?$/i.test(path)) files.push({ path, title: path.split("/").filter(Boolean).pop() ?? path, toolCallId: tool.id });
    }
  }
  return files;
}

/**
 * The value of a top-level string field in JSON that may still be arriving: decoded up to the
 * last complete character. `complete` requires the closing quote (a half-written path is not
 * a path yet).
 */
export function partialJsonString(text: string, key: string, complete = false): string | undefined {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!start) return undefined;
  let out = "";
  for (let index = start.index + start[0].length; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') return out;
    if (char !== "\\") { out += char; continue; }
    const next = text[index + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      index += 5;
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
    index += 1;
  }
  return complete ? undefined : out;
}

/**
 * What can be shown of a page before it is finished: no scripts (a half-written script fails,
 * and a whole one would run twice once the file opens) and no trailing half-written tag.
 */
export function streamingHtmlBody(html: string): string {
  let body = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/<script\b[\s\S]*$/i, "");
  const open = body.lastIndexOf("<");
  if (open > body.lastIndexOf(">")) body = body.slice(0, open);
  return body;
}
