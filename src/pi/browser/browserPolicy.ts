import type { ToolCallClass } from "../permissionPolicy.ts";
import type { BrowserElement } from "./browserProtocol.ts";

/**
 * How a browser action is approved (ADR-040), judged from the host's own snapshot of the page,
 * never from how the model describes the element:
 * - read: open a page, read it, scroll, go back, ask the user to take over.
 * - mutating: ordinary clicks and typing, a search form (GET), keys that move focus or edit text.
 *   Enter and Space act on the focused element and are judged like a click on it; with no
 *   focused element the snapshot knows, they are outward.
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
  /** The element focused in the latest snapshot. */
  focused?: BrowserElement;
};

const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
/** Roles the worker reads submit facts for: what they submit, and whether they take a secret. */
const ENRICHED = new Set(["textbox", "searchbox", "combobox", "button", "spinbutton"]);
/** Facts are read for at most this many interactive elements per snapshot. */
export const ENRICH_LIMIT = 200;

/**
 * Which elements the worker reads facts for, and which are past that limit. Elements past the limit
 * get no facts at all, so approval must treat them as unknown rather than as ordinary clicks — a
 * long page has far more than 200 interactive elements, and a POST button among them must not be
 * waved through just because it came later.
 */
export function enrichmentPlan(elements: Readonly<Record<string, BrowserElement>>, limit = ENRICH_LIMIT):
  { read: [string, BrowserElement][]; unknown: [string, BrowserElement][] } {
  const interactive = Object.entries(elements).filter(([, element]) => ENRICHED.has(element.role));
  return { read: interactive.slice(0, limit), unknown: interactive.slice(limit) };
}

/**
 * The submit facts of one element, read inside the page (ADR-040). It must stay self-contained:
 * the worker hands this function to Playwright, which serializes its source and runs it in the
 * page, so it cannot reference anything from this module.
 *
 * A submit button's own `formmethod` overrides its form's `method`, and Enter in a field submits
 * through the form's default button, whose override counts there too. `formMethod` is therefore
 * the method the browser will really use, not the form's declared one.
 */
export function elementSubmitFacts(node: Element) {
  const el = node as HTMLInputElement & HTMLButtonElement;
  const tag = el.tagName;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  const owner = (el.form ?? el.closest("form")) as HTMLFormElement | null;
  const formMethod = (owner?.getAttribute("method") ?? "get").toLowerCase();
  const methodOf = (button: Element) => (button.getAttribute("formmethod") ?? formMethod).toLowerCase();
  const isButton = tag === "BUTTON";
  const submits = Boolean(owner) && (isButton ? type === "" || type === "submit" : type === "submit" || type === "image");
  const isField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(el.isContentEditable);
  let effective: string | undefined;
  if (submits) effective = methodOf(el);
  else if (isField && owner) {
    // The browser's implicit submission picks the form's default button: the first submit button in
    // tree order that the form owns. `form.elements` is that set — it also holds a button linked by
    // `form="…"` from outside the form, which a query inside the form would miss.
    let defaultButton: Element | undefined;
    for (const candidate of owner.elements) {
      const candidateType = (candidate.getAttribute("type") ?? "").toLowerCase();
      if ((candidate.tagName === "BUTTON" && (candidateType === "" || candidateType === "submit")) ||
          (candidate.tagName === "INPUT" && (candidateType === "submit" || candidateType === "image"))) { defaultButton = candidate; break; }
    }
    effective = defaultButton ? methodOf(defaultButton) : formMethod;
  }
  return { inputType: type || tag.toLowerCase(), autocomplete, submits, formMethod: effective };
}

/** A click on `element`, or Enter/Space on it while it has focus. */
function activation(element: BrowserElement | undefined): ToolCallClass {
  if (!element) return "outward";
  // Facts that never arrived cannot be judged as an ordinary click.
  if (element.unresolved) return "outward";
  if (LASTING.test(element.name) || COOKIES.test(element.name)) return "outward";
  return element.submits ? submitClass(element) : "mutating";
}

export function secretElement(element: BrowserElement | undefined): boolean {
  if (!element) return false;
  return element.inputType === "password" || /one-time-code|cc-|current-password|new-password/.test(element.autocomplete ?? "");
}

function submitClass(element: BrowserElement | undefined): ToolCallClass {
  // Only a plain GET is an ordinary mutation. Anything else — post, dialog, or an element whose
  // facts the snapshot never got — reaches out, so a submit never rides along unapproved.
  if (!element || element.unresolved) return "outward";
  return element.formMethod && element.formMethod !== "get" ? "outward" : "mutating";
}

/** The class and the "always allow" key of one browser call; undefined for other tools. */
export function classifyBrowserCall(name: string, args: unknown, context: BrowserCallContext): { kind: ToolCallClass; key: string } | undefined {
  if (!name.startsWith("browser_")) return undefined;
  if (READ.has(name)) return { kind: "read", key: name };
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const element = typeof input.ref === "string" ? context.elements[input.ref] : undefined;
  let kind: ToolCallClass;
  if (name === "browser_click") {
    kind = activation(element);
  } else if (name === "browser_type") {
    if (!element || element.unresolved) kind = "outward";
    else if (secretElement(element)) kind = "secret";
    else kind = input.submit === true ? submitClass(element) : "mutating";
  } else if (name === "browser_press") {
    const focused = context.focused;
    if (input.key !== "Enter" && input.key !== "Space") kind = "mutating";
    else if (!focused) kind = "outward";
    else if (TEXT_ROLES.has(focused.role)) kind = input.key === "Enter" ? submitClass(focused) : "mutating";
    else if (["generic", "document", "main", "region", "group", "paragraph", "text"].includes(focused.role)) kind = "outward";
    else kind = activation(focused);
  } else kind = "outward";
  // Writes on a site the user signed into act as them there: ask, and remember per site.
  if (kind === "mutating" && context.origin && context.loggedIn.has(context.origin)) {
    return { kind: "connector", key: `${name}@${context.origin}` };
  }
  return { kind, key: name };
}
