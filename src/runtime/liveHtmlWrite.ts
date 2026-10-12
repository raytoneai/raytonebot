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
