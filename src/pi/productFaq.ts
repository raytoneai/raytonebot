import { composerCopy } from "../i18n/copy/composer.ts";
import { settingsCopy } from "../i18n/copy/settings.ts";
import { CHANNEL_PLATFORMS } from "./imChannels/types.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";

/**
 * What every role knows about RaytoneBot itself, so questions about the product are answered
 * from the prompt instead of by listing files or searching. Deployment facts are filled in by the
 * host; menu names, permission labels and IM setup steps are the UI's own copy, so answers match
 * the screen. Sent on every turn: keep it terse English.
 */
export function productFaq(input: { sandboxed: boolean; layout: WorkspaceLayout }): string {
  const { layout } = input;
  const ui = settingsCopy.zh;
  const menu = (key: keyof typeof ui.nav) => `${ui.title} → ${ui.nav[key]}`;
  const mode = composerCopy.zh.frame;
  const where = input.sandboxed
    ? "the user's own cloud sandbox (AgentSphere Linux microVM, 2 CPU/4 GB; survives pause/resume, owner backs it up). Agents run as a separate Linux user: no access to the bot's keys or data; network limited to package registries and the model service."
    : "the owner's computer (local development mode).";
  return [
    "## RaytoneBot facts (answer product questions from here, without tools; if not covered, say so)",
    "- Product: single-user AI work assistant, used in the browser or chat apps. Raer: Pi engine, fast everyday help. Tonny: Claude Code, plans, writes only to the shared directory. Bob: Codex CLI, implements and runs commands. Switching agents starts a new conversation.",
    `- Runs on ${where}${layout.shared ? ` Each agent has its own directory under ${layout.root}/agents.` : ""}`,
    `- Model: default service in ${menu("providers")} (DeepSeek by default). Key lives on the server; a key pasted in the browser stays in page memory. IM always uses the server key.`,
    `- Permissions (${menu("permissions")} or composer): ${mode.toolPermissionRequest} asks before changes; ${mode.toolPermissionAuto} asks only before outward actions; ${mode.toolPermissionAllowAll} never asks. Protected paths and secrets always ask or are refused.`,
    "- Files: attach in the composer; outputs and workspace files open in the right panel and download from there.",
    "- History: saved, searchable in the sidebar; edit or regenerate creates a branch.",
    `- IM (${menu("channels")}): ${CHANNEL_PLATFORMS.map((platform) => ui.channels.names[platform]).join(", ")}. Outbound connections, no public URL. Setup, then paste credentials and turn the channel on:`,
    ...CHANNEL_PLATFORMS.map((platform) => `  - ${ui.channels.names[platform]}: ${settingsCopy.en.channels.setup[platform]}`),
    "  - Only allowlisted user IDs; a stranger gets their ID to give the owner. Groups: mention the bot. Chat: /new, /stop; approve with 同意/总是允许/拒绝. Text only.",
    "- Personas: SOUL.md in each agent directory; user preferences in shared USER.md. Edits apply to new conversations.",
  ].join("\n");
}
