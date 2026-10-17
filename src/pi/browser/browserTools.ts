import type { HostToolSpec } from "../mcpServers.ts";
import { browserAccountScope } from "./browserPolicy.ts";

/** Suggested tasks, not permissions or proof of a currently signed-in account. */
const ACCOUNT_USES: Record<string, { service: string; examples: string }> = {
  "google.com": { service: "Google", examples: "Google search and YouTube research; Gmail/Drive only when the user specifically requests that private content." },
  "github.com": { service: "GitHub", examples: "Read repositories, code, issues and pull requests; private repositories only for the user's requested task." },
  "reddit.com": { service: "Reddit", examples: "Search and read posts, communities and comments." },
  "x.com": { service: "X", examples: "Search and read posts, profiles and threads." },
  "apple.com": { service: "Apple", examples: "Read the Apple/iCloud web content specifically requested by the user, if the current session permits it." },
};

/** Fresh each turn, including an empty list so historical account records cannot stay current. */
export function browserAccountHint(origins: ReadonlySet<string>, state: { controller: "user" | "agent"; clearing: boolean }): string {
  const scopes = [...new Set([...origins].map(browserAccountScope).filter((scope): scope is string => Boolean(scope)))].sort();
  const shown: string[] = [];
  for (const scope of scopes) {
    if (JSON.stringify([...shown, scope]).length > 300) break;
    shown.push(scope);
  }
  const omitted = scopes.length - shown.length;
  return `[Browser accounts now] ${JSON.stringify({ controller: state.controller, clearing: state.clearing, unverified: shown, ...(omitted ? { omitted } : {}) })}; supersedes older records; browser_accounts for full list.`;
}

export function browserAccountNote(origins: ReadonlySet<string>, state: { controller: "user" | "agent"; clearing: boolean }): string {
  const grouped = new Map<string, Set<string>>();
  for (const origin of origins) {
    const scope = browserAccountScope(origin);
    if (!scope) continue;
    const sites = grouped.get(scope) ?? new Set<string>();
    sites.add(new URL(origin).origin);
    grouped.set(scope, sites);
  }
  const accounts = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([scope, sites]) => ({
    scope, ...(ACCOUNT_USES[scope] ?? { service: scope, examples: "Read pages relevant to the user's requested task." }),
    origins: [...sites].sort(), status: "unverified",
  }));
  return `[Browser account context from RaytoneBot]\n${JSON.stringify({ controller: state.controller, clearing: state.clearing, accounts })}
These are sites visited during user takeover, not verified accounts or permission grants. The user may have signed out, switched accounts, or the session may have expired. No account identity is known. An empty list does not prove that the profile has no cookies.
Use browser_accounts to refresh this list. Browser tools share the user's saved profile; web_search/web_fetch and shell tools do not inherit it. For public reading prefer web_search/web_fetch; use the browser when a task needs interaction or an existing session.
Before claiming a login is usable, inspect the relevant site's current page with browser_open/browser_snapshot. Check only what the task needs; do not probe private services or enumerate private content. If signed out or blocked, say so and use browser_request_takeover when login is necessary; public searches can still work signed out. Never type passwords, one-time codes or payment details.
Account availability does not authorize tasks. Only access private content the user requested. Existing approval rules still apply to clicks/typing on account sites and sending, posting, deleting, purchasing or granting access. While controller=user, wait for the user to hand back control; while clearing=true, wait for clearing to finish. Refresh after takeover or clearing; older context may be stale.`;
}

/** The browser tools every engine gets (ADR-040). Results are text: URL, title, notes and the
 *  page's accessibility snapshot, whose `[ref=eN]` marks the elements an action may target. */
export const BROWSER_TOOL_SPECS: HostToolSpec[] = [
  { name: "browser_tabs", description: "List browser tabs, or select one by pageId. Popups become active automatically; closing them returns to their opener. Selecting a tab invalidates old refs: use the returned snapshot. Selecting a tab does not approve login or OAuth grants.",
    inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
  { name: "browser_wait_for", description: "Wait up to 10 seconds for visible text to appear or disappear, then read a fresh snapshot. Use for asynchronous content instead of repeating a click or submission. A timeout does not mean a prior action failed; observe before deciding what to do next.",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 500 }, hidden: { type: "boolean" }, timeoutMs: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["text"] } },
  { name: "browser_accounts", description: "List sites whose sessions may have been saved during user takeover, suggested uses and browser control status. Does not start the browser, inspect cookies or verify login. Refresh before relying on account availability, especially after takeover, sign-out or clearing. Verify only the relevant site's current page before claiming a usable login. Browser tools share the saved profile; web_search/web_fetch do not. Sites are unverified, with no known identity or permission grant; an empty list does not prove there are no cookies. Access only user-requested private content; existing approvals still apply. Never enter passwords, one-time codes or payment details; request takeover for login or blocks. Wait while controller=user or clearing=true.",
    inputSchema: { type: "object", properties: {} } },
  { name: "browser_open", description: "Open a web page in the shared browser the user can watch live. Returns the page's accessibility snapshot; elements carry [ref=…] for the other browser tools. Prefer web_fetch for plain reading; use the browser for sites that need interaction, scripts or a login.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL." } }, required: ["url"] } },
  { name: "browser_snapshot", description: "Read a fresh snapshot. Use scope (a CSS selector matching one region) to narrow a long page; mode=content for article/post text and links, interactive for controls, full for the accessibility tree. Long output reports an offset to continue the same snapshot. Refs belong to this conversation and snapshot; use the latest returned refs after actions, navigation or takeover. Never repeat an uncertain submission.",
    inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, scope: { type: "string", maxLength: 512 }, mode: { type: "string", enum: ["full", "interactive", "content"] } } } },
  { name: "browser_click", description: "Click an element by its ref from the latest snapshot. Sending, paying, buying, deleting, agreeing or accepting cookies asks the user every time.",
    inputSchema: { type: "object", properties: { ref: { type: "string", description: "e.g. e12" }, element: { type: "string", description: "What the element is, for the user." } }, required: ["ref"] } },
  { name: "browser_type", description: "Fill a text field by its ref, optionally pressing Enter to submit. Never use it for passwords, one-time codes or card numbers: ask the user to take over instead.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] } },
  { name: "browser_press", description: "Press one key: Enter, Escape, Tab, Backspace, Delete, arrows, PageUp, PageDown, Home, End or Space. Pass snapshotId from the latest tool result so an approval cannot apply to a different page or snapshot.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, snapshotId: { type: "string" } }, required: ["key", "snapshotId"] } },
  { name: "browser_scroll", description: "Scroll the page up or down by about one screen.",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"] } },
  { name: "browser_back", description: "Go back to the previous page.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_request_takeover", description: "Ask the user to take over the browser, e.g. to log in, solve a CAPTCHA or enter payment details. Waits until they finish or skip.",
    inputSchema: { type: "object", properties: { reason: { type: "string", description: "What the user should do, in their language." } }, required: ["reason"] } },
];
