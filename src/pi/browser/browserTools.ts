import type { HostToolSpec } from "../mcpServers.ts";
import { browserAccountScope } from "./browserPolicy.ts";

/** Suggested tasks, not permissions or proof of a currently signed-in account. */
const ACCOUNT_USES: Record<string, { service: string; examples: string }> = {
  "google.com": { service: "Google", examples: "Google search and YouTube research; Gmail/Drive only when the user specifically requests that private content." },
  "github.com": { service: "GitHub", examples: "Read repositories, code, issues and pull requests; private repositories only for the user's requested task." },
  "reddit.com": { service: "Reddit", examples: "Search and read posts, communities and comments." },
  "x.com": { service: "X", examples: "Search and read posts, profiles and threads." },
  "apple.com": { service: "Apple", examples: "Read the Apple/iCloud web content specifically requested by the user, if the current session permits it." },
  "xiaohongshu.com": { service: "小红书", examples: "Search and read notes, profiles and comments." },
  "weibo.com": { service: "微博", examples: "Search and read posts, profiles and comments." },
  "instagram.com": { service: "Instagram", examples: "Read posts, profiles and comments relevant to the user's requested task." },
  "facebook.com": { service: "Facebook", examples: "Read posts, pages and groups; private content only when the user specifically requests it." },
};

/** Fresh each turn, including an empty list so historical account records cannot stay current. */
export function browserAccountHint(origins: ReadonlySet<string>, state: { controller: "user" | "agent"; clearing: boolean }, redact = (text: string) => text): string {
  const scopes = [...new Set([...origins].map(browserAccountScope).filter((scope): scope is string => Boolean(scope)))].sort();
  const shown: string[] = [];
  for (const scope of scopes) {
    const safeScope = redact(scope);
    if (JSON.stringify([...shown, safeScope]).length > 300) break;
    shown.push(safeScope);
  }
  const omitted = scopes.length - shown.length;
  return `[Browser accounts now] ${JSON.stringify({ controller: state.controller, clearing: state.clearing, unverified: shown, ...(omitted ? { omitted } : {}) })}; supersedes older records; browser_accounts for full list.`;
}

export function browserAccountNote(origins: ReadonlySet<string>, state: { controller: "user" | "agent"; clearing: boolean }, redact = (text: string) => text): string {
  const grouped = new Map<string, Set<string>>();
  for (const origin of origins) {
    const scope = browserAccountScope(origin);
    if (!scope) continue;
    const sites = grouped.get(scope) ?? new Set<string>();
    sites.add(new URL(origin).origin);
    grouped.set(scope, sites);
  }
  const accounts = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([scope, sites]) => {
    const uses = ACCOUNT_USES[scope] ?? { service: scope, examples: "Read pages relevant to the user's requested task." };
    return { scope: redact(scope), service: redact(uses.service), examples: uses.examples,
      origins: [...sites].sort().map(redact), status: "unverified" };
  });
  return `[Browser account context from RaytoneBot]\n${JSON.stringify({ controller: state.controller, clearing: state.clearing, accounts })}
These are sites visited during user takeover, not verified accounts or permission grants. The user may have signed out, switched accounts, or the session may have expired. No account identity is known. An empty list does not prove that the profile has no cookies.
Use browser_accounts to refresh this list. Browser tools share the user's saved profile; web_search/web_fetch and shell tools do not inherit it. For public reading prefer web_search/web_fetch; use the browser when a task needs interaction or an existing session.
Before claiming a login is usable, inspect the relevant site's current page with browser_open/browser_snapshot. Check only what the task needs; do not probe private services or enumerate private content. If login is necessary, use vault_request_use to request a saved or securely entered login with one-time user consent, or browser_request_takeover for manual login or blocks; public searches can still work signed out. Never put passwords, one-time codes or payment details in browser_type. After Vault fill, request takeover for the user to inspect and submit.
Account availability does not authorize tasks. Only access private content the user requested. Existing approval rules still apply to clicks/typing on account sites and sending, posting, deleting, purchasing or granting access. While controller=user, wait for the user to hand back control; while clearing=true, wait for clearing to finish. Refresh after takeover or clearing; older context may be stale.`;
}

/** Shared browser tools. Snapshots carry refs; screenshots additionally return model image content. */
export const BROWSER_TOOL_SPECS: HostToolSpec[] = [
  { name: "browser_tabs", description: "List browser tabs, or select one by pageId. Popups become active automatically; closing them returns to their opener. Selecting a tab invalidates old refs: use the returned snapshot. Selecting a tab does not approve login or OAuth grants.",
    inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
  { name: "browser_wait_for", description: "Wait up to 10 seconds for visible text to appear or disappear, then read a fresh snapshot. Use for asynchronous content instead of repeating a click or submission. A timeout does not mean a prior action failed; observe before deciding what to do next.",
    inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 500 }, hidden: { type: "boolean" }, timeoutMs: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["text"] } },
  { name: "browser_accounts", description: "List sites whose sessions may have been saved during user takeover, suggested uses and browser control status. Does not start the browser, inspect cookies or verify login. Refresh before relying on account availability, especially after takeover, sign-out or clearing. Verify only the relevant site's current page before claiming a usable login. Browser tools share the saved profile; web_search/web_fetch do not. Sites are unverified, with no known identity or permission grant; an empty list does not prove there are no cookies. Access only user-requested private content; existing approvals still apply. For login use vault_request_use with separate user consent or request takeover. Never enter passwords, one-time codes or payment details with browser_type. Wait while controller=user or clearing=true.",
    inputSchema: { type: "object", properties: {} } },
  { name: "browser_open", description: "Open a web page in the shared browser the user can watch live. Returns the page's accessibility snapshot; elements carry [ref=…] for the other browser tools. Prefer web_fetch for plain reading; use the browser for sites that need interaction, scripts or a login.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL." } }, required: ["url"] } },
  { name: "browser_snapshot", description: "Read a fresh snapshot, including accessible iframe content. To focus inside a frame, pass its iframe ref from the latest snapshot as frameRef; scope then selects one CSS region inside that frame. Nested frames work by selecting their returned iframe ref. Without frameRef, scope selects a top-level region. Use mode=content for text/links or interactive for controls. Long output reports an offset to continue the same snapshot. Refs belong to this conversation and snapshot; refresh after actions, frame navigation or takeover. Never repeat an uncertain submission.",
    inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0 }, frameRef: { type: "string", description: "An iframe ref from the latest snapshot, not a URL or selector." }, scope: { type: "string", maxLength: 512 }, mode: { type: "string", enum: ["full", "interactive", "content"] } } } },
  { name: "browser_screenshot", description: "Read a viewport screenshot when layout, a chart or other visual content is missing from the text snapshot. Requires a model that accepts images. Pass the latest snapshotId; continue to use snapshot refs for actions, never infer clickable refs from pixels. Unavailable during user takeover or after Vault fill; populated secret fields also block capture. Use text snapshots for ordinary reading.",
    inputSchema: { type: "object", properties: { snapshotId: { type: "string" } }, required: ["snapshotId"] } },
  { name: "browser_click", description: "Click an element by its ref from the latest snapshot. Sending, paying, buying, deleting, agreeing or accepting cookies asks the user every time.",
    inputSchema: { type: "object", properties: { ref: { type: "string", description: "e.g. e12" }, element: { type: "string", description: "What the element is, for the user." } }, required: ["ref"] } },
  { name: "browser_type", description: "Fill a text field by its ref, optionally pressing Enter to submit. Never use it for passwords, one-time codes or card numbers. Logins use vault_request_use to show a saved-login choice or secure input card with one-time user consent; otherwise ask the user to take over.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] } },
  { name: "browser_press", description: "Press one key: Enter, Escape, Tab, Backspace, Delete, arrows, PageUp, PageDown, Home, End or Space. Pass snapshotId from the latest tool result so an approval cannot apply to a different page or snapshot.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, snapshotId: { type: "string" } }, required: ["key", "snapshotId"] } },
  { name: "browser_scroll", description: "Scroll the page up or down by about one screen.",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"] } },
  { name: "browser_back", description: "Go back to the previous page.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_request_takeover", description: "Ask the user to take over the browser, e.g. to log in, solve a CAPTCHA or enter payment details. Waits until they finish or skip.",
    inputSchema: { type: "object", properties: { reason: { type: "string", description: "What the user should do, in their language." } }, required: ["reason"] } },
];
