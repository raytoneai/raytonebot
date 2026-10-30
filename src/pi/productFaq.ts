import type { AppLocale } from "../i18n/locales.ts";
import { composerCopy } from "../i18n/copy/composer.ts";
import { settingsCopy } from "../i18n/copy/settings.ts";
import { vaultCopy } from "../i18n/copy/vault.ts";
import { CHANNEL_PLATFORMS } from "./imChannels/types.ts";
import type { WorkspaceLayout } from "./workspaceLayout.ts";

/**
 * What every role knows about RaytoneBot itself, so questions about the product are answered
 * from the prompt instead of by listing files or searching. Deployment facts are filled in by the
 * host; menu names, permission labels and IM setup steps are the UI's own copy, so answers match
 * the screen. Sent on every turn: keep it terse English.
 */
export function productFaq(input: { sandboxed: boolean; layout: WorkspaceLayout; locale?: AppLocale }): string {
  const { layout } = input;
  const locale = input.locale ?? "en";
  const ui = settingsCopy[locale];
  const menu = (key: keyof typeof ui.nav) => `${ui.title} → ${ui.nav[key]}`;
  const mode = composerCopy[locale].frame;
  const where = input.sandboxed
    ? "the user's own cloud sandbox (AgentSphere Linux microVM, 2 CPU/4 GB; survives pause/resume, owner backs it up). Agents run as a separate Linux user: no access to the bot's keys or data; direct network limited to package registries and the model service; web search and page reading go through the bot's web_search / web_fetch tools."
    : "the owner's computer (local development mode).";
  return [
    "## RaytoneBot facts (answer product questions from here, without tools; if not covered, say so)",
    "- Product: single-user AI work assistant, used in the browser or chat apps. Switching agents starts a new conversation. Claude Code Bots' file writes are limited to the shared directory; tool permissions are enforced by the host.",
    `- Runs on ${where}${layout.shared ? ` Each agent has its own directory under ${layout.root}/agents.` : ""}`,
    `- Model: default service in ${menu("providers")} (DeepSeek by default). ${input.sandboxed ? "Its key is stored inside this sandbox, readable only by the bot process, never by agents" : "Its key is in the server environment"}; a key pasted in the browser stays in page memory. IM always uses the server key.`,
    `- Permissions (${menu("permissions")} or composer): ${mode.toolPermissionRequest} asks before changes; ${mode.toolPermissionAuto} asks only before outward actions; ${mode.toolPermissionAllowAll} skips ordinary tool approvals. Protected paths and secrets always ask or are refused. Vault use always requires a separate user answer in every mode.`,
    `- Login Vault (${ui.title} → ${vaultCopy[locale].nav}): save, edit, disable or delete website logins there; never ask for credentials in chat. When the task requires login, call vault_request_use with the current browser refs: the host lets the user choose a matching login or securely enter a new one, optionally save it, and authorize one fill on the exact HTTPS origin. Do not ask the user to go to Settings first or send credentials in chat; wait for the result and stop the login step on cancellation or expiry. No cards, codes, embedded frames or new-password forms. Direct web conversations only. Filling does not submit; request browser takeover to inspect and submit afterward.`,
    "- Files: attach in the composer; outputs and workspace files open in the right panel and download from there.",
    "- History: saved, searchable in the sidebar; edit or regenerate creates a branch.",
    `- IM (${menu("channels")}): ${CHANNEL_PLATFORMS.map((platform) => ui.channels.names[platform]).join(", ")}. Outbound connections, no public URL. In the web app Pi Bots connect Telegram from chat (connect_channel: secure token card, then the user's first message pairs them). Never ask anyone to paste tokens or user IDs into chat. Manual setup, then paste credentials and turn the channel on:`,
    ...CHANNEL_PLATFORMS.map((platform) => `  - ${ui.channels.names[platform]}: ${settingsCopy.en.channels.setup[platform]}`),
    "  - Only allowlisted user IDs; a stranger gets their ID to give the owner. Groups: mention the bot. Chat: /new, /stop; approve with 同意/总是允许/拒绝. Text only.",
    "- Personas: SOUL.md in each agent directory; user preferences in shared USER.md. Character and current Bot names are refreshed on each turn.",
  ].join("\n");
}
