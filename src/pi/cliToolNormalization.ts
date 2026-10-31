type Json = Record<string, unknown>;

/** Tool name and arguments as Pi spells them, so titles, approvals and artifacts line up. */
export type NormalizedTool = { name: string; args: Json };

const CLAUDE_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "find",
  LS: "ls",
  mcp__raytone__web_search: "web_search",
  mcp__raytone__web_fetch: "web_fetch",
  mcp__raytone__remember: "remember",
  mcp__raytone__forget: "forget",
};

export function normalizeClaudeTool(name: string, input: unknown): NormalizedTool {
  const raw = asRecord(input);
  // Unlisted tools in this host namespace fall back to their suffix.
  const mapped = CLAUDE_TOOL_NAMES[name] ?? (name.startsWith("mcp__raytone__") ? name.slice("mcp__raytone__".length) : undefined);
  if (!mapped) return { name, args: raw };
  const { file_path: filePath, notebook_path: notebookPath, old_string: oldText, new_string: newText, ...rest } = raw;
  const path = stringValue(filePath) ?? stringValue(notebookPath);
  return {
    name: mapped,
    args: {
      ...rest,
      ...(path ? { path } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    },
  };
}

export function codexTool(itemType: string | undefined, item: Json): NormalizedTool | undefined {
  switch (itemType) {
    case "command_execution":
      return { name: "bash", args: { command: displayCommand(stringValue(item.command) ?? "") } };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
      const first = changes[0];
      const path = first ? stringValue(first.path) : undefined;
      return {
        name: first && stringValue(first.kind) === "add" && changes.length === 1 ? "write" : "edit",
        args: { ...(path ? { path } : {}), changes },
      };
    }
    case "mcp_tool_call":
      return {
        name: [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join(".") || "mcp",
        args: asRecord(item.arguments),
      };
    case "web_search":
      return { name: "web_search", args: { query: stringValue(item.query) ?? "" } };
    default:
      // Error notices and future item types carry no tool to show.
      return undefined;
  }
}

export function codexToolOutput(itemType: string | undefined, item: Json): string {
  if (itemType === "command_execution") return stringValue(item.aggregated_output) ?? "";
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
    return changes.map((change) => `${stringValue(change.kind) ?? "update"} ${stringValue(change.path) ?? ""}`).join("\n");
  }
  if (item.error != null) return typeof item.error === "string" ? item.error : JSON.stringify(item.error);
  if (item.result !== undefined) return typeof item.result === "string" ? item.result : JSON.stringify(item.result);
  return "";
}

/** Codex wraps commands in the login shell (`/bin/zsh -lc ls`); show what the agent ran. */
export function displayCommand(command: string): string {
  const wrapped = /^\/\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!wrapped) return command;
  const inner = wrapped[1].trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
  return quoted ? quoted[2] : inner;
}

export function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
