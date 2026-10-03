import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AGENT_PRESETS, type AgentPresetId } from "./harnessCatalog.ts";

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

/** Create the directories and leave a short brief in each; existing briefs are not overwritten. */
export function ensureWorkspaceLayout(layout: WorkspaceLayout): void {
  for (const dir of new Set(Object.values(layout.agents))) mkdirSync(dir, { recursive: true });
  if (!layout.shared) return;
  mkdirSync(layout.shared, { recursive: true });
  for (const [role, dir] of Object.entries(layout.agents)) {
    const brief = join(dir, "AGENTS.md");
    if (!existsSync(brief)) writeFileSync(brief, workspaceBrief(role as AgentPresetId, layout));
  }
  const readme = join(layout.shared, "README.md");
  if (!existsSync(readme)) writeFileSync(readme, sharedReadme(layout));
}

/** The same facts as the briefs, for agents that do not read AGENTS.md (Claude Code in safe mode). */
export function workspacePrompt(role: AgentPresetId, layout: WorkspaceLayout): string | undefined {
  if (!layout.shared) return undefined;
  return [
    `Your own working directory is ${layout.agents[role]}.`,
    `${layout.shared} is shared by every RaytoneBot agent (assistant, planner, builder):`,
    "read it for handoffs from the others, and write plans, results and files meant for them there.",
    "Do not change another agent's own directory.",
  ].join(" ");
}

function workspaceBrief(role: AgentPresetId, layout: WorkspaceLayout): string {
  return `# Workspace (${role})

This directory is your own working directory in RaytoneBot.

- Shared with every agent: \`${layout.shared}\`. Read it for handoffs from the other agents;
  put plans, results and files meant for them there.
- Other agents' directories: ${AGENT_PRESETS.filter((preset) => preset.id !== role)
    .map((preset) => `\`${layout.agents[preset.id]}\` (${preset.id})`).join(", ")}. Do not change them.
- Suggested handoff names in the shared directory: \`plans/<topic>.md\`, \`handoffs/<from>-to-<to>.md\`, \`artifacts/\`.
`;
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
