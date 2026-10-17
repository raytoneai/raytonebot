import { getDomain } from "tldts";
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

export const BROWSER_TOOL_NAMES = ["browser_accounts", "browser_tabs", "browser_wait_for", "browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_scroll", "browser_back", "browser_request_takeover"] as const;

const READ = new Set(["browser_accounts", "browser_tabs", "browser_wait_for", "browser_open", "browser_snapshot", "browser_scroll", "browser_back", "browser_request_takeover"]);
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
  if (kind === "mutating" && context.origin && hasRelatedLogin(context.origin, context.loggedIn)) {
    return { kind: "connector", key: `${name}@${context.origin}` };
  }
  return { kind, key: name };
}

// Related domains affect whether to ask, never the origin-scoped "always allow" key.
// Google's published search domains, checked 2026-10-17: https://www.google.com/supported_domains
const GOOGLE_DOMAINS = new Set(`
google.com google.ad google.ae google.com.af google.com.ag google.al google.am google.co.ao
google.com.ar google.as google.at google.com.au google.az google.ba google.com.bd google.be
google.bf google.bg google.com.bh google.bi google.bj google.com.bn google.com.bo google.com.br
google.bs google.bt google.co.bw google.by google.com.bz google.ca google.cd google.cf google.cg
google.ch google.ci google.co.ck google.cl google.cm google.cn google.com.co google.co.cr
google.com.cu google.cv google.com.cy google.cz google.de google.dj google.dk google.dm
google.com.do google.dz google.com.ec google.ee google.com.eg google.es google.com.et google.fi
google.com.fj google.fm google.fr google.ga google.ge google.gg google.com.gh google.com.gi
google.gl google.gm google.gr google.com.gt google.gy google.com.hk google.hn google.hr google.ht
google.hu google.co.id google.ie google.co.il google.im google.co.in google.iq google.is google.it
google.je google.com.jm google.jo google.co.jp google.co.ke google.com.kh google.ki google.kg
google.co.kr google.com.kw google.kz google.la google.com.lb google.li google.lk google.co.ls
google.lt google.lu google.lv google.com.ly google.co.ma google.md google.me google.mg google.mk
google.ml google.com.mm google.mn google.com.mt google.mu google.mv google.mw google.com.mx
google.com.my google.co.mz google.com.na google.com.ng google.com.ni google.ne google.nl google.no
google.com.np google.nr google.nu google.co.nz google.com.om google.com.pa google.com.pe
google.com.pg google.com.ph google.com.pk google.pl google.pn google.com.pr google.ps google.pt
google.com.py google.com.qa google.ro google.ru google.rw google.com.sa google.com.sb google.sc
google.se google.com.sg google.sh google.si google.sk google.com.sl google.sn google.so google.sm
google.sr google.st google.com.sv google.td google.tg google.co.th google.com.tj google.tl
google.tm google.tn google.to google.com.tr google.tt google.com.tw google.co.tz google.com.ua
google.co.ug google.co.uk google.com.uy google.co.uz google.com.vc google.co.ve google.co.vi
google.com.vn google.vu google.ws google.rs google.co.za google.co.zm google.co.zw google.cat
`.trim().split(/\s+/));

const ACCOUNT_FAMILIES = [
  ["google.com", "gmail.com", "googlemail.com", "youtube.com", "youtu.be"],
  ["x.com", "twitter.com"],
  ["apple.com", "icloud.com"],
];
export function browserAccountScope(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const domain = getDomain(url.hostname, { allowPrivateDomains: true });
    if (!domain) return url.origin;
    if (GOOGLE_DOMAINS.has(domain)) return "google.com";
    return ACCOUNT_FAMILIES.find((sites) => sites.includes(domain))?.[0] ?? domain;
  } catch { return undefined; }
}
function hasRelatedLogin(origin: string, loggedIn: ReadonlySet<string>): boolean {
  const scope = browserAccountScope(origin);
  return scope !== undefined && [...loggedIn].some((site) => browserAccountScope(site) === scope);
}

/** User-selected login destinations still pass through the browser's network proxy. */
export function browserLoginUrl(site: unknown, address?: unknown): string {
  const sites: Record<string, string> = {
    google: "https://accounts.google.com/", github: "https://github.com/login",
    reddit: "https://www.reddit.com/login/", x: "https://x.com/i/flow/login",
    apple: "https://account.apple.com/sign-in",
  };
  if (typeof site !== "string") throw new Error("Unknown login site.");
  if (Object.hasOwn(sites, site)) return sites[site];
  if (site !== "other") throw new Error("Unknown login site.");
  if (typeof address !== "string" || address.length > 4096) throw new Error("Enter an http(s) URL.");
  const url = new URL(address);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Enter an http(s) URL without embedded credentials.");
  return url.href;
}
