/**
 * The agent engines RaytoneBot can drive, and the preset roles built on them.
 * Browser-safe: no Node imports.
 *
 * Every harness ends in the same AgentUX events (CLI streams are translated to Pi's session
 * vocabulary and run through `piAdapter`), so switching roles never changes the UI.
 */
export type AgentHarnessId = "pi" | "claude-code" | "codex";

/** A preset agent: one harness plus the job it is best at. Labels live in i18n copy. */
export type AgentPresetId = "assistant" | "planner" | "builder";

export type AgentPreset = {
  id: AgentPresetId;
  harness: AgentHarnessId;
  /** Engine tools withheld from this role; enforced by the engine, never only described in a prompt. */
  disallowedTools?: readonly string[];
};

export const AGENT_PRESETS: readonly AgentPreset[] = [
  // Default: Pi answers fastest and runs in-process.
  { id: "assistant", harness: "pi" },
  // Claude Code in plan mode: reads and plans, never edits.
  { id: "planner", harness: "claude-code", disallowedTools: ["Edit", "MultiEdit", "NotebookEdit"] },
  // Codex CLI: implements in the workspace.
  { id: "builder", harness: "codex" },
];

export const DEFAULT_AGENT_PRESET_ID: AgentPresetId = "assistant";

/** Where a CLI harness gets its model: the configured provider (e.g. DeepSeek) or its local login. */
export type ClaudeCodeModelSource = "provider" | "local-login";
export type CliModelSource = ClaudeCodeModelSource;

export type AgentSettings = {
  presetId: AgentPresetId;
  claudeCodeModelSource: ClaudeCodeModelSource;
  /** Codex speaks only the Responses API, which DeepSeek and OpenAI serve; no login needed. */
  codexModelSource: CliModelSource;
};

export type AgentHarnessStatus = {
  id: AgentHarnessId;
  available: boolean;
  version?: string;
  error?: string;
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  presetId: DEFAULT_AGENT_PRESET_ID,
  claudeCodeModelSource: "provider",
  codexModelSource: "provider",
};

export function isAgentHarnessId(value: unknown): value is AgentHarnessId {
  return value === "pi" || value === "claude-code" || value === "codex";
}

export function isAgentPresetId(value: unknown): value is AgentPresetId {
  return AGENT_PRESETS.some((preset) => preset.id === value);
}

export function agentPreset(id: AgentPresetId): AgentPreset {
  return AGENT_PRESETS.find((preset) => preset.id === id) ?? AGENT_PRESETS[0];
}

/** Whether a run with these settings uses the provider connection configured in settings. */
export function settingsUseProvider(settings: AgentSettings): boolean {
  const { harness } = agentPreset(settings.presetId);
  if (harness === "pi") return true;
  if (harness === "claude-code") return settings.claudeCodeModelSource === "provider";
  return settings.codexModelSource === "provider";
}

/**
 * Anthropic-format endpoints for providers that offer one, so Claude Code can run on them.
 * Claude Code appends `/v1/messages` itself; these must not end in `/v1`.
 */
const ANTHROPIC_COMPATIBLE_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/anthropic",
};

export function anthropicBaseUrlForProvider(provider: {
  id: string;
  protocol: string;
  baseUrl: string;
}): string | undefined {
  const known = ANTHROPIC_COMPATIBLE_BASE_URLS[provider.id];
  if (known) return known;
  if (provider.protocol === "anthropic") return provider.baseUrl.replace(/\/v1\/?$/, "");
  return undefined;
}

const STORAGE_KEY = "raytonebot.agentSettings";

export function loadAgentSettings(): AgentSettings {
  if (typeof window === "undefined") return DEFAULT_AGENT_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AgentSettings>;
    return {
      presetId: isAgentPresetId(parsed.presetId) ? parsed.presetId : DEFAULT_AGENT_SETTINGS.presetId,
      claudeCodeModelSource: parsed.claudeCodeModelSource === "local-login" ? "local-login" : "provider",
      codexModelSource: parsed.codexModelSource === "local-login" ? "local-login" : "provider",
    };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

export function saveAgentSettings(settings: AgentSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or quota: the choice still applies for this page.
  }
}
