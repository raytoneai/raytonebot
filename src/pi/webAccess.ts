import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isPublicAddress } from "./runtime/modelGateway.ts";

/**
 * Web search and page reading for every engine. Node-only; runs in the bot process.
 *
 * Agent processes have no egress (ADR-034): the bot performs the request and hands back text.
 * The search key stays in the bot's environment; fetches reach public addresses only, checked
 * at connect time so DNS rebinding cannot point a public name at the VM or its metadata service.
 */

export type WebToolName = "web_search" | "web_fetch";
export type WebToolResult = { text: string; isError: boolean };
export type WebTools = { run(name: string, args: unknown, signal?: AbortSignal): Promise<WebToolResult> };

/** JSON Schema shared by the CLI engines (Claude's in-process MCP, Codex dynamic tools). */
export const WEB_TOOL_SPECS: readonly { name: WebToolName; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: "web_search",
    description: "Search the web. Returns titles, URLs and short excerpts of the top results. Use web_fetch to read a result in full.",
    inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: 400, description: "Search query." },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "Number of results, default 5." },
      time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from this recent period." },
    } },
  },
  {
    name: "web_fetch",
    description: "Read a public web page or text file (HTML, Markdown, JSON, XML, plain text) and return its text. Long pages come in parts: call again with the offset it reports.",
    inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: {
      url: { type: "string", minLength: 1, maxLength: 4000, description: "http(s) URL." },
      offset: { type: "integer", minimum: 0, description: "Character offset to continue a long page from." },
    } },
  },
];

const PAGE_CHARS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 10 * 60_000;
const USER_AGENT = "Mozilla/5.0 (compatible; RaytoneBot/0.1)";

export class WebAccessError extends Error {}

export function createWebTools(options: {
  env?: NodeJS.ProcessEnv;
  /** Tavily API calls only; page fetches use the address-checked client below. */
  fetcher?: typeof fetch;
  getPage?: typeof getPublicPage;
  /** Local development behind a TUN proxy: its fake-IP DNS answers in 198.18.0.0/15. */
  proxyFakeIp?: boolean;
} = {}): WebTools {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;
  const getPage = options.getPage ?? getPublicPage;
  // Paging through a long page must not download it again for every part.
  const pages = new Map<string, { text: string; at: number }>();

  async function tavily(path: "search" | "extract", body: Record<string, unknown>, signal: AbortSignal) {
    const key = env.TAVILY_API_KEY?.trim();
    if (!key) throw new WebAccessError("Web search is not configured on this host (TAVILY_API_KEY is missing). web_fetch still reads known URLs.");
    const response = await fetcher(`https://api.tavily.com/${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal, redirect: "error",
    });
    if (response.status === 401 || response.status === 403) throw new WebAccessError("The search service rejected TAVILY_API_KEY.");
    if (response.status === 429 || response.status === 432 || response.status === 433) throw new WebAccessError("The search service quota or rate limit is exhausted; try again later.");
    if (!response.ok) throw new WebAccessError(`The search service returned HTTP ${response.status}.`);
    return await response.json() as Record<string, unknown>;
  }

  async function search(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const query = typeof args.query === "string" ? args.query.trim().slice(0, 400) : "";
    if (!query) throw new WebAccessError("web_search needs a query.");
    const maxResults = Number.isInteger(args.max_results) ? Math.min(10, Math.max(1, args.max_results as number)) : 5;
    const timeRange = ["day", "week", "month", "year"].includes(String(args.time_range)) ? args.time_range : undefined;
    const data = await tavily("search", { query, max_results: maxResults, search_depth: "basic", ...(timeRange ? { time_range: timeRange } : {}) }, signal);
    const results = (Array.isArray(data.results) ? data.results : []).map(record).filter((item) => typeof item.url === "string");
    if (!results.length) return `No results for "${query}".`;
    return results.map((item, index) => [
      `${index + 1}. ${clean(item.title) || item.url}`,
      `   ${item.url}`,
      ...(clean(item.content) ? [`   ${clean(item.content).slice(0, 600)}`] : []),
    ].join("\n")).join("\n\n");
  }

  async function read(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const raw = typeof args.url === "string" ? args.url.trim() : "";
    let url: URL;
    try { url = new URL(raw); } catch { throw new WebAccessError("web_fetch needs an absolute http(s) URL."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebAccessError("web_fetch reads http(s) URLs only.");
    if (url.username || url.password) throw new WebAccessError("URLs with credentials are not fetched.");
    url.hash = "";
    const offset = Number.isInteger(args.offset) && (args.offset as number) > 0 ? args.offset as number : 0;
    let cached = pages.get(url.href);
    if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
      const page = await getPage(url, signal, { proxyFakeIp: options.proxyFakeIp });
      let text = page.text;
      // Script-rendered pages leave almost nothing in the HTML; the search service renders them.
      if (page.html && text.length < 200 && env.TAVILY_API_KEY?.trim()) {
        const extracted = await tavily("extract", { urls: [page.url], format: "markdown" }, signal).catch(() => undefined);
        const content = record((Array.isArray(extracted?.results) ? extracted.results : [])[0]).raw_content;
        if (typeof content === "string" && content.trim().length > text.length) text = content.trim();
      }
      cached = { text: `${page.url !== url.href ? `(Redirected to ${page.url})\n\n` : ""}${text || "(The page has no readable text.)"}`, at: Date.now() };
      pages.set(url.href, cached);
      for (const [key, value] of pages) if (pages.size > 20 || Date.now() - value.at > CACHE_TTL_MS) pages.delete(key);
    }
    const { text } = cached;
    if (offset >= text.length && offset > 0) throw new WebAccessError(`Offset ${offset} is past the end of the page (${text.length} characters).`);
    const end = Math.min(text.length, offset + PAGE_CHARS);
    const part = text.slice(offset, end);
    return end < text.length || offset > 0
      ? `${part}\n\n[Characters ${offset}–${end} of ${text.length}.${end < text.length ? ` Call web_fetch with offset=${end} to continue.` : ""}]`
      : part;
  }

  return {
    async run(name, args, signal) {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        if (name === "web_search") return { text: await search(record(args), combined), isError: false };
        if (name === "web_fetch") return { text: await read(record(args), combined), isError: false };
        return { text: `Unknown web tool: ${name}`, isError: true };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof WebAccessError ? error.message
          : timeout.aborted ? "The web request timed out."
          : `The web request failed${error instanceof Error && error.message ? `: ${error.message}` : "."}`;
        return { text: message, isError: true };
      }
    },
  };
}

/** Text of a public http(s) resource, following redirects with the same address checks. */
export async function getPublicPage(start: URL, signal: AbortSignal, options: { proxyFakeIp?: boolean } = {}): Promise<{ url: string; text: string; html: boolean }> {
  const allowed = (address: string) => isPublicAddress(address) || (options.proxyFakeIp === true && /^198\.1[89]\./.test(address));
  let url = start;
  for (let hop = 0; ; hop++) {
    const response = await openPublic(url, signal, allowed);
    const location = response.headers.location;
    if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.resume();
      if (hop >= MAX_REDIRECTS) throw new WebAccessError("Too many redirects.");
      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new WebAccessError("Redirect to a non-http(s) URL was not followed.");
      url = next;
      continue;
    }
    if (!response.statusCode || response.statusCode >= 400) {
      response.resume();
      throw new WebAccessError(`The page returned HTTP ${response.statusCode ?? "error"}.`);
    }
    const type = String(response.headers["content-type"] ?? "").toLowerCase();
    if (type && !/^text\/|html|json|xml|javascript|ecmascript|yaml|csv|markdown/.test(type)) {
      response.resume();
      throw new WebAccessError(`web_fetch reads text pages only; this URL is ${type.split(";")[0]}.`);
    }
    const decoded = decode(await readBody(response), type);
    const html = /html/.test(type) || (!type && /^\s*<(!doctype html|html)/i.test(decoded));
    return { url: url.href, html, text: html ? htmlToText(decoded, url) : decoded.trim() };
  }
}

function openPublic(url: URL, signal: AbortSignal, allowed: (address: string) => boolean): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Node skips `lookup` for IP literals, so they are checked here.
  if (isIP(host) && !isPublicAddress(host)) return Promise.reject(new WebAccessError("Private and local addresses are not fetched."));
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", signal, lookup: publicLookup(allowed),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5", "accept-encoding": "gzip, deflate, br" },
    }, resolve);
    req.once("error", (error) => reject(error));
    req.end();
  });
}

/** Connect only to the address that was checked; every resolved address must be public. */
function publicLookup(allowed: (address: string) => boolean) {
  return (hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const list = addresses as LookupAddress[];
    if (!list.length || list.some(({ address }) => !allowed(address))) return callback(new WebAccessError("Private and local addresses are not fetched."), "");
    if ((options as { all?: boolean }).all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase().trim();
  const stream = encoding === "gzip" || encoding === "x-gzip" ? response.pipe(createGunzip())
    : encoding === "deflate" ? response.pipe(createInflate())
    : encoding === "br" ? response.pipe(createBrotliDecompress()) : response;
  if (stream !== response) response.once("error", (error) => stream.destroy(error));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    // Keep what arrived: the start of a large page is still worth reading.
    if (size > MAX_BYTES) { chunks.push(Buffer.from(chunk).subarray(0, chunk.length - (size - MAX_BYTES))); response.destroy(); break; }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function decode(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  try { return new TextDecoder(declared ?? "utf-8").decode(body); }
  catch { return new TextDecoder("utf-8").decode(body); }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

/** Readable text with headings, list items and links kept as Markdown. */
export function htmlToText(html: string, base?: URL): string {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, tag: string, inner: string) => `\n\n${"#".repeat(Number(tag[1]))} ${inner}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      let target: string | undefined;
      try { target = new URL(decodeEntities(href), base).href; } catch { target = undefined; }
      return label && target && /^https?:/.test(target) && target !== base?.href ? `[${label}](${target})` : label;
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|tr|table|ul|ol|blockquote|pre|dl|dd|dt|figure|figcaption)\s*>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text)
    .split("\n").map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim()).join("\n")
    .replace(/\n(- )?\n+(?=- )/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title && !text.startsWith(`# ${title}`) ? `# ${title}\n\n${text}` : text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
