import type { HostToolSpec } from "../mcpServers.ts";

/** The browser tools every engine gets (ADR-040). Results are text: URL, title, notes and the
 *  page's accessibility snapshot, whose `[ref=eN]` marks the elements an action may target. */
export const BROWSER_TOOL_SPECS: HostToolSpec[] = [
  { name: "browser_open", description: "Open a web page in the shared browser the user can watch live. Returns the page's accessibility snapshot; elements carry [ref=…] for the other browser tools. Prefer web_fetch for plain reading; use the browser for sites that need interaction, scripts or a login.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "http(s) URL." } }, required: ["url"] } },
  { name: "browser_snapshot", description: "Read the current page again as an accessibility snapshot. Long snapshots come in parts: pass the offset it reports.",
    inputSchema: { type: "object", properties: { offset: { type: "integer", minimum: 0 } } } },
  { name: "browser_click", description: "Click an element by its ref from the latest snapshot. Sending, paying, buying, deleting, agreeing or accepting cookies asks the user every time.",
    inputSchema: { type: "object", properties: { ref: { type: "string", description: "e.g. e12" }, element: { type: "string", description: "What the element is, for the user." } }, required: ["ref"] } },
  { name: "browser_type", description: "Fill a text field by its ref, optionally pressing Enter to submit. Never use it for passwords, one-time codes or card numbers: ask the user to take over instead.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, required: ["ref", "text"] } },
  { name: "browser_press", description: "Press one key on the page: Enter, Escape, Tab, Backspace, Delete, arrows, PageUp, PageDown, Home, End or Space.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "browser_scroll", description: "Scroll the page up or down by about one screen.",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] } }, required: ["direction"] } },
  { name: "browser_back", description: "Go back to the previous page.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_request_takeover", description: "Ask the user to take over the browser, e.g. to log in, solve a CAPTCHA or enter payment details. Waits until they finish or skip.",
    inputSchema: { type: "object", properties: { reason: { type: "string", description: "What the user should do, in their language." } }, required: ["reason"] } },
];
