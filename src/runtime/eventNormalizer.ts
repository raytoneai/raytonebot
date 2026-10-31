import { AGENT_UX_EVENT_TYPES, type AgentUXEvent } from "@agent-ux/protocol";
import { limitEventText } from "./eventLimits.ts";

/**
 * Read-only normalization preview for AgentUX replay diagnostics.
 * It reports existing presentation concepts, preview-derived artifacts, and held-back events;
 * input is unchanged and the shell never substitutes the returned events for replay.
 */

export type ToolConcept =
  | "read-file"
  | "read-image"
  | "edit-file"
  | "write-file"
  | "run-command"
  | "search"
  | "validate"
  | "fetch"
  | "delete"
  | "plan";

/** Tool-name aliases for the existing presentation concepts. */
export const TOOL_CONCEPT_ALIASES: Record<ToolConcept, readonly string[]> = {
  "read-file": ["read_file", "read", "open_file", "scan_file", "cat", "view_file", "get_file"],
  "read-image": ["read_image", "view_image", "image"],
  "edit-file": ["edit_file", "edit", "str_replace", "str_replace_editor", "apply_patch", "patch"],
  "write-file": ["write_file", "write", "create_file", "append_file", "modify_file", "save_file", "put_file"],
  // No bare "run": token matching would misclassify validation tools as shell commands.
  "run-command": ["bash", "sh", "shell", "shell.exec", "run_command", "exec", "terminal", "start_server"],
  search: ["search", "grep", "ripgrep", "rg", "glob", "find", "codebase_search"],
  validate: ["validate", "test", "check", "verify", "lint", "typecheck", "run_tests", "run_checks"],
  fetch: ["fetch", "web.fetch", "web_search", "http", "curl", "browse"],
  delete: ["rm", "delete", "delete_file", "remove_file", "filesystem.rm"],
  // Plan snapshots use the existing artifact presentation; omit raw plan tool rows from preview.
  plan: ["todo", "todos", "update_todo", "update_todo_list", "todo_write", "plan", "update_plan", "task_list"],
};

/** Canonical tool names recorded by the diagnostic preview for known concepts. */
const CANONICAL_TOOL_NAME: Record<ToolConcept, string> = {
  "read-file": "read_file",
  "read-image": "read_image",
  "edit-file": "edit_file",
  "write-file": "write_file",
  "run-command": "run_command",
  search: "search",
  validate: "validate",
  fetch: "fetch",
  delete: "rm",
  plan: "plan",
};

/** Concepts whose raw tool rows are represented by another existing presentation. */
export const UNRENDERED_CONCEPTS: readonly ToolConcept[] = ["plan"];

/** Concepts whose successful completion produces a file we can show as an artifact. */
const ARTIFACT_PRODUCING: readonly ToolConcept[] = ["write-file", "edit-file"];

/** Tool markers used to identify harness bookkeeping in the diagnostic preview. */
export const DIAGNOSTIC_MARKERS: readonly string[] = [
  "runtime-context", "runtime_context", "runtime context",
  "system-reminder", "system_reminder",
  "token-usage", "token_usage", "usage-report", "model-response-usage",
  "permission-preset", "permission_preset",
  "sandbox-mode", "sandbox_mode",
  "approval-policy", "approval_policy",
  "config-update", "config_update",
];

/** Protocol types recognised by the preview; unknown types are reported without changing input. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(AGENT_UX_EVENT_TYPES);

export type NormalizeOptions = {
  /** Extra wording that marks an event as harness bookkeeping. */
  diagnosticMarkers?: readonly string[];
  /** Extra aliases, merged into our table. */
  extraAliases?: Partial<Record<ToolConcept, readonly string[]>>;
  /** Derive artifact events from file-writing tool calls. Default true. */
  deriveArtifacts?: boolean;
  /** Rebuild tool titles that are raw JSON. Default true. */
  normalizeTitles?: boolean;
};

/** Why the diagnostic preview marked an event as held back. Unknown tool names remain listed in `undesignedTools`. */
export type RejectedEvent = {
  event: unknown;
  reason: "diagnostic" | "unrenderable-concept" | "unknown-type";
  detail: string;
};

export type NormalizeResult = {
  /** Events retained by the diagnostic preview; not an instruction to replace actual replay. */
  events: AgentUXEvent[];
  /** Everything received, in order — the debug dock shows this. */
  allEvents: unknown[];
  /** Marked as held back by the diagnostic preview, with the reason. */
  rejected: RejectedEvent[];
  /** Artifact events we synthesised, and from which tool call. */
  derivedArtifacts: Array<{ toolCallId: string; path: string }>;
  /** Tool titles we rebuilt because they carried raw JSON. */
  normalizedTitles: Array<{ toolCallId: string; from: string; to: string }>;
  /** Canonical tool names recorded by the diagnostic preview. */
  canonicalizedNames: Array<{ toolCallId: string; from: string; to: string }>;
  /** Tool calls with no matching existing concept, retained in the preview for inspection. */
  undesignedTools: Array<{ toolCallId: string; name: string }>;
};

function payloadOf(event: unknown): Record<string, unknown> {
  const candidate = (event as { payload?: unknown })?.payload;
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : {};
}

function typeOf(event: unknown): string {
  const value = (event as { type?: unknown })?.type;
  return typeof value === "string" ? value : "";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeName(value: string): string {
  // Drop any namespace prefix ("filesystem.rm" -> "rm") and unify separators.
  return value.toLowerCase().replace(/^.*[./]/, "").replace(/[\s-]+/g, "_");
}

function tokensOf(value: string): string[] {
  return normalizeName(value).split("_").filter(Boolean);
}

/**
 * Resolve a tool to one of our concepts, or undefined if our vocabulary has no place for it.
 *
 * Matching is token-based, never substring: a raw `includes` made "frobnicate_widget" resolve
 * to read-file (it contains "cat") and "dsh_put_blob" to run-command (it contains "sh").
 * Only the tool name is considered — titles are free text and a message mentioning "test"
 * must not become a validate tool.
 */
export function resolveToolConcept(
  name: string | undefined,
  title?: string,
  extraAliases?: Partial<Record<ToolConcept, readonly string[]>>,
): ToolConcept | undefined {
  void title;
  const raw = str(name);
  if (!raw) return undefined;
  const normalized = normalizeName(raw);
  const tokens = new Set(tokensOf(raw));

  const entries = Object.entries(TOOL_CONCEPT_ALIASES) as Array<[ToolConcept, readonly string[]]>;
  const aliasesFor = (concept: ToolConcept, aliases: readonly string[]) =>
    [...aliases, ...(extraAliases?.[concept] ?? [])];

  // 1) Whole-name match — most reliable.
  for (const [concept, aliases] of entries) {
    if (aliasesFor(concept, aliases).some((alias) => normalizeName(alias) === normalized)) return concept;
  }
  // 2) Token-set match: every token of the alias must appear as a token of the name, so
  //    "file_write" still resolves to write-file, while "frobnicate_widget" resolves to
  //    nothing.
  for (const [concept, aliases] of entries) {
    for (const alias of aliasesFor(concept, aliases)) {
      const aliasTokens = tokensOf(alias);
      if (aliasTokens.length > 0 && aliasTokens.every((token) => tokens.has(token))) return concept;
    }
  }
  return undefined;
}

function isDiagnostic(event: unknown, extra: readonly string[]): boolean {
  const payload = payloadOf(event);
  const haystack = [payload.name, payload.title, payload.toolCallId]
    .filter(str).join(" ").toLowerCase();
  if (!haystack) return false;
  return [...DIAGNOSTIC_MARKERS, ...extra].some((marker) => haystack.includes(marker.toLowerCase()));
}

function looksLikeRawJson(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 12) return false;
  // "write {\"file_path\": …}" — a verb followed by a JSON blob, or a bare JSON blob.
  return /\{\s*"/.test(trimmed) || (trimmed.startsWith("{") && trimmed.endsWith("}"));
}

function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file", "filename", "target", "uri"]) {
    const value = str(record[key]);
    if (value) return value;
  }
  return undefined;
}

function commandFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return str(record.command) ?? str(record.cmd) ?? str(record.script);
}

function contentFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["content", "contents", "text", "new_str", "newText", "body", "patch", "diff"]) {
    const value = str(record[key]);
    if (value) return value;
  }
  return undefined;
}

/** Pull the args object out of a title that carries a raw JSON blob. */
function argsFromRawTitle(title: string): unknown {
  const start = title.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(title.slice(start));
  } catch {
    // Truncated blob (titles are often elided). Recover just the path.
    const match = /"(?:file_)?path"\s*:\s*"([^"]+)"/.exec(title);
    return match ? { path: match[1] } : undefined;
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

const CONCEPT_VERB: Record<ToolConcept, string> = {
  "read-file": "Read",
  "read-image": "View",
  "edit-file": "Edit",
  "write-file": "Write",
  "run-command": "Run",
  search: "Search",
  validate: "Validate",
  fetch: "Fetch",
  delete: "Delete",
  plan: "Plan",
};

function titleFor(concept: ToolConcept, args: unknown, fallback: string): string {
  const path = pathFromArgs(args);
  if (path) return `${CONCEPT_VERB[concept]} ${basename(path)}`;
  const command = commandFromArgs(args);
  if (command) return `${CONCEPT_VERB[concept]} ${command.split(/\s+/).slice(0, 4).join(" ")}`;
  return fallback;
}

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "md" || ext === "mdx") return "text/markdown";
  if (ext === "json") return "application/json";
  if (ext === "css") return "text/css";
  if (ext === "ts" || ext === "tsx") return "text/typescript";
  if (ext === "js" || ext === "jsx") return "text/javascript";
  if (ext === "diff" || ext === "patch") return "text/x-diff";
  return "text/plain";
}

function artifactKindFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "preview";
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "json") return "data";
  if (ext === "diff" || ext === "patch") return "diff";
  return "code";
}

/** Build a read-only diagnostic preview for a raw event stream; the input and replay remain untouched. */
export function normalizeAgentUXEvents(
  input: readonly unknown[],
  options: NormalizeOptions = {},
): NormalizeResult {
  const extraMarkers = options.diagnosticMarkers ?? [];
  const deriveArtifacts = options.deriveArtifacts ?? true;
  const normalizeTitles = options.normalizeTitles ?? true;

  const events: AgentUXEvent[] = [];
  const rejected: RejectedEvent[] = [];
  const derivedArtifacts: NormalizeResult["derivedArtifacts"] = [];
  const normalizedTitles: NormalizeResult["normalizedTitles"] = [];
  const canonicalizedNames: NormalizeResult["canonicalizedNames"] = [];
  const undesignedTools: NormalizeResult["undesignedTools"] = [];

  // Per tool call: the concept it resolved to, plus what we learned along the way.
  const concepts = new Map<string, ToolConcept | undefined>();
  const paths = new Map<string, string>();
  const contents = new Map<string, string>();
  const rejectedCalls = new Set<string>();
  let derivedSeq = 0;

  /**
   * Artifact URIs the stream already carries.
   *
   * Deriving an artifact from a completed write assumes the backend does not report artifacts
   * itself. Pi does — it emits `artifact.created/delta/finished` for the same write — so the
   * output panel listed the file twice, once from Pi and once from this derivation. Correlated
   * on the `file://` uri rather than on any id shape, because that is the field both sides
   * already agree on; nothing here should know a vendor's id prefix.
   */
  const streamArtifactUris = new Set<string>();
  for (const candidate of input) {
    const record = candidate as { type?: unknown; payload?: unknown };
    if (record?.type !== "artifact.finished") continue;
    const uri = str((record.payload as Record<string, unknown> | undefined)?.uri);
    if (uri) streamArtifactUris.add(uri);
  }

  const idOf = (payload: Record<string, unknown>) => str(payload.toolCallId) ?? "";

  for (const event of input) {
    const type = typeOf(event);
    const payload = payloadOf(event);

    if (!type || !KNOWN_TYPES.has(type)) {
      rejected.push({ event, reason: "unknown-type", detail: type || "(missing type)" });
      continue;
    }

    if (isDiagnostic(event, extraMarkers)) {
      // Later events of the same call carry no name, so remember the id too — otherwise the
      // `finished` event slipped through and left a half-rendered row in the preview.
      const diagnosticId = str(payload.toolCallId);
      if (diagnosticId) rejectedCalls.add(diagnosticId);
      rejected.push({ event, reason: "diagnostic", detail: str(payload.name) ?? type });
      continue;
    }

    if (!type.startsWith("tool.call.")) {
      events.push(event as AgentUXEvent);
      continue;
    }

    const id = idOf(payload);

    if (type === "tool.call.started") {
      const concept = resolveToolConcept(str(payload.name), str(payload.title), options.extraAliases);
      concepts.set(id, concept);

      if (!concept) {
        // Retained in the preview: the component's own matcher gets a shot at it, and whatever
        // interaction the call carries (an approval, a result) remains in the actual replay.
        undesignedTools.push({ toolCallId: id, name: str(payload.name) ?? "(no name)" });
      }
      if (concept && UNRENDERED_CONCEPTS.includes(concept)) {
        rejectedCalls.add(id);
        rejected.push({ event, reason: "unrenderable-concept", detail: `${concept} — 当前没有对应组件` });
        continue;
      }
    }

    // Every later event of a preview-held call is marked too, so no half-rendered rows appear
    // in the diagnostic projection.
    if (rejectedCalls.has(id)) {
      const reason = concepts.get(id) ? "unrenderable-concept" : "diagnostic";
      rejected.push({ event, reason, detail: type });
      continue;
    }

    const concept = concepts.get(id);
    let normalized = event;

    // Remember args for artifact derivation and title rebuilding.
    if (payload.args !== undefined) {
      const path = pathFromArgs(payload.args);
      if (path) paths.set(id, path);
      const content = contentFromArgs(payload.args);
      if (content) contents.set(id, content);
    }

    // Canonicalise the tool name so the components' own matchers resolve it.
    if (concept && str(payload.name) && normalizeName(str(payload.name)!) !== CANONICAL_TOOL_NAME[concept]) {
      const current = payloadOf(normalized);
      normalized = { ...(normalized as object), payload: { ...current, name: CANONICAL_TOOL_NAME[concept] } };
      canonicalizedNames.push({ toolCallId: id, from: str(payload.name)!, to: CANONICAL_TOOL_NAME[concept] });
    }

    if (normalizeTitles && concept) {
      const title = str(payloadOf(normalized).title);
      if (title && looksLikeRawJson(title)) {
        // `tool.call.started` usually predates `args`, but a title carrying the args blob has
        // the path inside it — parse there so the rebuilt title is still specific.
        const rebuilt = titleFor(concept, payload.args ?? argsFromRawTitle(title), CONCEPT_VERB[concept]);
        normalized = { ...(normalized as object), payload: { ...payloadOf(normalized), title: rebuilt } };
        normalizedTitles.push({ toolCallId: id, from: title, to: rebuilt });
      }
    }

    events.push(normalized as AgentUXEvent);

    // A completed write is where an artifact becomes available.
    if (
      deriveArtifacts &&
      type === "tool.call.finished" &&
      concept &&
      ARTIFACT_PRODUCING.includes(concept) &&
      str(payload.status) === "success"
    ) {
      const path = paths.get(id);
      const content = contents.get(id);
      if (path && content && !streamArtifactUris.has(`file://${path}`)) {
        derivedSeq += 1;
        const artifactId = `derived_artifact_${derivedSeq}`;
        const base = event as { runId?: string; ts?: number };
        const wrap = (suffix: string, artifactPayload: Record<string, unknown>): AgentUXEvent => ({
          protocol: "agent-ux",
          version: "0.1",
          id: `${artifactId}_${suffix}`,
          runId: base.runId,
          ts: base.ts,
          type: `artifact.${suffix}`,
          payload: artifactPayload,
        });
        events.push(
          wrap("created", {
            artifactId,
            kind: artifactKindFor(path),
            title: basename(path),
            mimeType: mimeFor(path),
          }),
          wrap("delta", { artifactId, format: "text", delta: limitEventText(content) }),
          wrap("finished", { artifactId, status: "success", uri: `file://${path}` }),
        );
        derivedArtifacts.push({ toolCallId: id, path });
      }
    }
  }

  return {
    events,
    allEvents: [...input],
    rejected,
    derivedArtifacts,
    normalizedTitles,
    canonicalizedNames,
    undesignedTools,
  };
}

/** Grouped counts for reporting. */
export function summarizeRejections(rejected: readonly RejectedEvent[]): Record<RejectedEvent["reason"], number> {
  const summary: Record<RejectedEvent["reason"], number> = {
    diagnostic: 0,
    "unrenderable-concept": 0,
    "unknown-type": 0,
  };
  for (const item of rejected) summary[item.reason] += 1;
  return summary;
}
