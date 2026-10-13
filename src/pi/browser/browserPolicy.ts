import type { ToolCallClass } from "../permissionPolicy.ts";
import type { BrowserElement } from "./browserProtocol.ts";

/**
 * How a browser action is approved (ADR-040), judged from the host's own snapshot of the page,
 * never from how the model describes the element:
 * - read: open a page, read it, scroll, go back, ask the user to take over.
 * - mutating: ordinary clicks and typing, a search form (GET), pressing keys.
 * - connector: the same on a site the user logged into by taking over; "always allow" is per site.
 * - outward: what reaches someone else or cannot be undone: submitting a POST form, a button that
 *   sends, pays, buys, deletes, agrees or accepts cookies, or any element the snapshot does not know.
 * - secret: typing into a password, one-time-code or card field. Refused; the user types it.
 */

export const BROWSER_TOOL_NAMES = ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_back", "browser_request_takeover"] as const;

const READ = new Set(["browser_open", "browser_snapshot", "browser_scroll", "browser_back", "browser_request_takeover"]);
const LASTING = /\b(send|pay|buy|purchase|order|checkout|delete|remove|agree|accept|confirm|subscribe|unsubscribe|publish|post|transfer|donate|sign ?up|register|book|reserve)\b|发送|支付|付款|购买|下单|结算|删除|移除|同意|接受|确认|订阅|发布|转账|注册|预订|预约|提交订单/i;
const COOKIES = /cookie|cookies|全部接受|接受全部|接受所有/i;

export type BrowserCallContext = {
  /** Refs from the latest snapshot. */
  elements: Record<string, BrowserElement>;
  /** The page's origin now, e.g. https://github.com. */
  origin?: string;
  /** Origins the user logged into while in control of the browser. */
  loggedIn: ReadonlySet<string>;
  /** The field typed into last, which Enter would submit. */
  lastTyped?: BrowserElement;
};

export function secretElement(element: BrowserElement | undefined): boolean {
  if (!element) return false;
  return element.inputType === "password" || /one-time-code|cc-|current-password|new-password/.test(element.autocomplete ?? "");
}

function submitClass(element: BrowserElement | undefined): ToolCallClass {
  return element?.formMethod === "post" ? "outward" : "mutating";
}

/** The class and the "always allow" key of one browser call; undefined for other tools. */
export function classifyBrowserCall(name: string, args: unknown, context: BrowserCallContext): { kind: ToolCallClass; key: string } | undefined {
  if (!name.startsWith("browser_")) return undefined;
  if (READ.has(name)) return { kind: "read", key: name };
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const element = typeof input.ref === "string" ? context.elements[input.ref] : undefined;
  let kind: ToolCallClass;
  if (name === "browser_click") {
    if (!element) kind = "outward";
    else if (LASTING.test(element.name) || COOKIES.test(element.name)) kind = "outward";
    else kind = element.submits ? submitClass(element) : "mutating";
  } else if (name === "browser_type") {
    if (!element) kind = "outward";
    else if (secretElement(element)) kind = "secret";
    else kind = input.submit === true ? submitClass(element) : "mutating";
  } else if (name === "browser_press") {
    kind = input.key === "Enter" ? submitClass(context.lastTyped) : "mutating";
  } else kind = "outward";
  // Writes on a site the user signed into act as them there: ask, and remember per site.
  if (kind === "mutating" && context.origin && context.loggedIn.has(context.origin)) {
    return { kind: "connector", key: `${name}@${context.origin}` };
  }
  return { kind, key: name };
}
