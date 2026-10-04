import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AGENT_PRESETS, type AgentPresetId } from "./harnessCatalog.ts";
import { DEFAULT_SOULS, DEFAULT_USER, LEGACY_SOULS } from "./rolePrompt.ts";

/**
 * Where each agent works. Node-only.
 *
 * With `RAYTONEBOT_WORKSPACE_ROOT` set (the cloud sandbox), every preset role gets its own
 * directory and all of them share one public directory for coordination:
 *
 *   <root>/agents/<role>/   the role's working directory (its cwd)
 *   <root>/shared/          readable and writable by every role: plans, handoffs, artifacts
 *
 * Without it (local development) every role keeps working in one directory, as before.
 */
export type WorkspaceLayout = {
  root?: string;
  shared?: string;
  agents: Record<AgentPresetId, string>;
};

export function resolveWorkspaceLayout(options: { fallbackCwd: string; root?: string }): WorkspaceLayout {
  const root = options.root?.trim() ? resolve(options.root.trim()) : undefined;
  const agents = Object.fromEntries(
    AGENT_PRESETS.map((preset) => [preset.id, root ? join(root, "agents", preset.id) : resolve(options.fallbackCwd)]),
  ) as Record<AgentPresetId, string>;
  return { root, shared: root ? join(root, "shared") : undefined, agents };
}

/**
 * Create the directories and leave a short brief in each, plus the user-editable persona files
 * (`SOUL.md` per role, `shared/USER.md`). Edited files are never overwritten; a brief still
 * holding an earlier generated text is brought up to date.
 */
export function ensureWorkspaceLayout(layout: WorkspaceLayout): void {
  for (const dir of new Set(Object.values(layout.agents))) mkdirSync(dir, { recursive: true });
  if (!layout.shared) return;
  mkdirSync(layout.shared, { recursive: true });
  for (const [role, dir] of Object.entries(layout.agents) as [AgentPresetId, string][]) {
    refresh(join(dir, "AGENTS.md"), workspaceBrief(role, layout), legacyBriefs(role, layout));
    refresh(join(dir, "SOUL.md"), DEFAULT_SOULS[role], LEGACY_SOULS[role]);
  }
  const readme = join(layout.shared, "README.md");
  if (!existsSync(readme)) writeFileSync(readme, sharedReadme(layout));
  const user = join(layout.shared, "USER.md");
  if (!existsSync(user)) writeFileSync(user, DEFAULT_USER);
}

/** Writes `content` when the file is missing or still holds an earlier generated version. */
function refresh(path: string, content: string, generated: readonly string[]) {
  if (!existsSync(path) || generated.includes(readFileSync(path, "utf8"))) writeFileSync(path, content);
}

/** Short: the role prompt carries the same facts; this is for engines that read AGENTS.md natively. */
function workspaceBrief(role: AgentPresetId, layout: WorkspaceLayout): string {
  const others = AGENT_PRESETS.filter((preset) => preset.id !== role).map((preset) => `\`${layout.agents[preset.id]}\``).join(", ");
  return `# Workspace (${role})

Shared: \`${layout.shared}\` (handoffs, plans, other agents' work only; names: \`plans/<topic>.md\`, \`handoffs/<from>-to-<to>.md\`, \`artifacts/\`). Do not change ${others}.
`;
}

/** Briefs written by earlier versions; the first told agents to read the shared directory every turn. */
function legacyBriefs(role: AgentPresetId, layout: WorkspaceLayout): string[] {
  return [
    "Read it for handoffs from the other agents;\n  put plans, results and files meant for them there.",
    "Look there only when a task mentions a handoff,\n  a plan or another agent's work; put files meant for the others there.",
  ].map((sharedLine) => `# Workspace (${role})

This directory is your own working directory in RaytoneBot.

- Shared with every agent: \`${layout.shared}\`. ${sharedLine}
- Other agents' directories: ${AGENT_PRESETS.filter((preset) => preset.id !== role)
    .map((preset) => `\`${layout.agents[preset.id]}\` (${preset.id})`).join(", ")}. Do not change them.
- Suggested handoff names in the shared directory: \`plans/<topic>.md\`, \`handoffs/<from>-to-<to>.md\`, \`artifacts/\`.
`);
}

function sharedReadme(layout: WorkspaceLayout): string {
  return `# Shared workspace

Every RaytoneBot agent can read and write here: the assistant (Pi), the planner (Claude Code)
and the builder (Codex CLI). Use it to coordinate.

- \`plans/\`: plans written for others to follow
- \`handoffs/\`: notes from one agent to another, named \`<from>-to-<to>.md\`
- \`artifacts/\`: files produced for the user or other agents

Agent directories: ${AGENT_PRESETS.map((preset) => `\`${layout.agents[preset.id]}\``).join(", ")}.
`;
}
