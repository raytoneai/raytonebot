import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { browserLoginUrl, ENRICH_LIMIT, classifyBrowserCall, elementSubmitFacts, enrichmentPlan } from "./browserPolicy.ts";
import { createBrowserService, findHeadlessShell } from "./browserService.ts";
import { BROWSER_TOOL_SPECS, browserAccountNote } from "./browserTools.ts";
import { PiApprovalGate } from "../approvalGate.ts";
import { ApprovalMemory } from "../approvalMemory.ts";
import { startEgressProxy } from "./egressProxy.ts";
import { saveWorkspaceDownload } from "../workspaceFiles.ts";
import { resolveWorkspaceLayout } from "../workspaceLayout.ts";

const context = (elements: Record<string, object>, extra: object = {}) => ({ elements: elements as never, loggedIn: new Set<string>(), origin: "https://shop.example", ...extra });

test("browser actions are judged from the host's snapshot, never the model's label", () => {
  const elements = {
    e1: { role: "link", name: "Docs" },
    e2: { role: "button", name: "Send message" },
    e3: { role: "button", name: "Accept all cookies" },
    e4: { role: "button", name: "Search", submits: true, formMethod: "get" },
    e5: { role: "button", name: "Continue", submits: true, formMethod: "post" },
    e6: { role: "textbox", name: "Password", inputType: "password" },
    e7: { role: "textbox", name: "Code", autocomplete: "one-time-code" },
    e8: { role: "searchbox", name: "Search", inputType: "search", formMethod: "get" },
    e9: { role: "textbox", name: "Comment", formMethod: "post" },
    e10: { role: "button", name: "立即支付" },
  };
  const kind = (name: string, args: object, extra?: object) => classifyBrowserCall(name, args, context(elements, extra))?.kind;
  for (const name of ["browser_accounts", "browser_open", "browser_snapshot", "browser_scroll", "browser_back", "browser_request_takeover"]) assert.equal(kind(name, {}), "read", name);
  assert.equal(kind("browser_click", { ref: "e1", element: "Delete account" }), "mutating", "the model's description does not count");
  assert.equal(kind("browser_click", { ref: "e2" }), "outward");
  assert.equal(kind("browser_click", { ref: "e3" }), "outward", "cookie banners ask");
  assert.equal(kind("browser_click", { ref: "e4" }), "mutating", "a GET search form");
  assert.equal(kind("browser_click", { ref: "e5" }), "outward", "a POST form");
  assert.equal(kind("browser_click", { ref: "e10" }), "outward");
  assert.equal(kind("browser_click", { ref: "e99" }), "outward", "an element the snapshot does not know");
  assert.equal(kind("browser_type", { ref: "e6", text: "x" }), "secret");
  assert.equal(kind("browser_type", { ref: "e7", text: "x" }), "secret");
  assert.equal(kind("browser_type", { ref: "e8", text: "x", submit: true }), "mutating");
  assert.equal(kind("browser_type", { ref: "e9", text: "x" }), "mutating");
  assert.equal(kind("browser_type", { ref: "e9", text: "x", submit: true }), "outward");
  // Enter and Space act on whatever has focus, judged like a click on it.
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e2 }), "outward", "Tab to Send, then Enter");
  assert.equal(kind("browser_press", { key: "Space" }, { focused: elements.e10 }), "outward");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e5 }), "outward", "a POST form's button");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e9 }), "outward", "Enter in a POST form's field");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e8 }), "mutating", "a GET search field");
  assert.equal(kind("browser_press", { key: "Space" }, { focused: elements.e9 }), "mutating", "a space typed into a field");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: elements.e1 }), "mutating", "a plain link");
  assert.equal(kind("browser_press", { key: "Enter" }), "outward", "nothing known to be focused");
  assert.equal(kind("browser_press", { key: "Enter" }, { focused: { role: "generic", name: "" } }), "outward", "the page itself");
  assert.equal(kind("browser_press", { key: "Tab" }), "mutating");
  assert.equal(classifyBrowserCall("bash", {}, context(elements)), undefined);
  // Signed in by the user: ordinary writes ask and are remembered per site; outward stays outward.
  const signedIn = { loggedIn: new Set(["https://shop.example"]) };
  assert.deepEqual(classifyBrowserCall("browser_click", { ref: "e1" }, context(elements, signedIn)), { kind: "connector", key: "browser_click@https://shop.example" });
  assert.equal(kind("browser_click", { ref: "e2" }, signedIn), "outward");
});

test("a submit button's own formmethod decides, for clicks and for Enter in a field", () => {
  // Just enough of the DOM for elementSubmitFacts, which runs in the page and reads these members.
  type FakeForm = {
    getAttribute(name: string): string | null;
    /** The browser's own collection: every control the form owns, in tree order. */
    readonly elements: Fake[];
    /** What a query inside the form finds — deliberately not the same set, so going back to a
     *  subtree search would miss the `form="…"` button asserted below. */
    querySelectorAll(selector: string): Fake[];
  };
  type Fake = {
    tagName: string;
    form?: FakeForm;
    isContentEditable?: boolean;
    attributes: Record<string, string>;
    getAttribute(name: string): string | null;
    closest(selector: string): FakeForm | null;
  };
  const owner = (method: string | undefined, inside: Fake[] = [], outside: Fake[] = []): FakeForm => ({
    getAttribute: (name: string) => (name === "method" ? method ?? null : null),
    get elements() { return [...inside, ...outside]; },
    querySelectorAll: () => inside,
  });
  const make = (tagName: string, attributes: Record<string, string>, form?: FakeForm): Fake => ({
    tagName, form, attributes,
    getAttribute: (name) => attributes[name] ?? null,
    closest: () => form ?? null,
  });

  // <form method="get"><button formmethod="post">Continue</button></form>
  const buttons: Fake[] = [];
  const getForm = owner("get", buttons);
  const override = make("BUTTON", { formmethod: "post" }, getForm);
  const field = make("INPUT", {}, getForm);
  buttons.push(override, field);
  const facts = (element: Fake) => elementSubmitFacts(element as unknown as Element);
  const classOf = (name: string, args: object, element: Fake, key = "e1") =>
    classifyBrowserCall(name, args, context({ [key]: { role: element === override ? "button" : "textbox", name: "Continue", ...facts(element) } }))?.kind;

  // The regression: the form says get, the button's own formmethod says post, and the browser posts.
  assert.equal(facts(override).formMethod, "post");
  // Playwright serializes this function and runs it in the page, where no module scope exists.
  const revived = new Function(`return (${String(elementSubmitFacts)})`)() as typeof elementSubmitFacts;
  assert.equal(revived(override as unknown as Element).formMethod, "post", "the page-side function must survive serialization");
  assert.equal(classOf("browser_click", { ref: "e1" }, override), "outward");
  // Enter in the field submits through that same default button.
  assert.equal(facts(field).formMethod, "post");
  assert.equal(classOf("browser_type", { ref: "e1", text: "x", submit: true }, field), "outward");
  assert.equal(classifyBrowserCall("browser_press", { key: "Enter" },
    context({}, { focused: { role: "textbox", name: "", ...facts(field) } }))?.kind, "outward");

  // The override works the other way too, and a plain GET form stays an ordinary mutation.
  const postForm = owner("post", []);
  const getOverride = make("BUTTON", { formmethod: "get" }, postForm);
  assert.equal(facts(getOverride).formMethod, "get");
  assert.equal(classOf("browser_click", { ref: "e1" }, getOverride), "mutating");
  const plain = make("BUTTON", {}, postForm);
  assert.equal(facts(plain).formMethod, "post");
  assert.equal(classOf("browser_click", { ref: "e1" }, plain), "outward");
  const plainGet = make("BUTTON", {}, owner("get", []));
  assert.equal(classOf("browser_click", { ref: "e1" }, plainGet), "mutating");
  // A method the policy does not know must not be treated as an ordinary mutation.
  const dialog = make("BUTTON", { formmethod: "dialog" }, owner("get", []));
  assert.equal(classOf("browser_click", { ref: "e1" }, dialog), "outward");
  // A field in a form whose only button submits with GET is still an ordinary mutation.
  const searchButtons: Fake[] = [];
  const searchForm = owner("get", searchButtons);
  const searchButton = make("BUTTON", {}, searchForm);
  const searchField = make("INPUT", { type: "search" }, searchForm);
  searchButtons.push(searchButton, searchField);
  assert.equal(facts(searchField).formMethod, "get");
  assert.equal(classOf("browser_type", { ref: "e1", text: "x", submit: true }, searchField), "mutating");

  // A button linked by `form="…"` sits outside the form in the DOM but is still the form's default
  // submit button, and only `form.elements` lists it.
  const insideOnly: Fake[] = [];
  const linked: Fake[] = [];
  const linkedForm = owner("get", insideOnly, linked);
  const linkedField = make("INPUT", {}, linkedForm);
  const linkedButton = make("BUTTON", { formmethod: "post" }, linkedForm);
  insideOnly.push(linkedField);
  linked.push(linkedButton);
  assert.equal(linkedForm.querySelectorAll("button, input").length, 1, "a query inside the form cannot see the linked button");
  assert.equal(facts(linkedField).formMethod, "post");
  assert.equal(classOf("browser_type", { ref: "e1", text: "x", submit: true }, linkedField), "outward");
});

test("an element whose facts never arrived is asked about, not assumed to be an ordinary click", () => {
  const kinds = (element: object) => classifyBrowserCall("browser_click", { ref: "e1" }, context({ e1: { role: "button", name: "Go", ...element } }))?.kind;
  // A known GET submit is still an ordinary mutation...
  assert.equal(kinds({ submits: true, formMethod: "get" }), "mutating");
  // ...but facts that never arrived (the read timed out, the element went away) must ask.
  assert.equal(kinds({ unresolved: true, submits: true, formMethod: "get" }), "outward");
  assert.equal(kinds({ unresolved: true }), "outward");
  const field = { role: "textbox", name: "Note", unresolved: true };
  assert.equal(classifyBrowserCall("browser_type", { ref: "e1", text: "x" }, context({ e1: field }))?.kind, "outward");
  assert.equal(classifyBrowserCall("browser_type", { ref: "e1", text: "x", submit: true }, context({ e1: field }))?.kind, "outward");
  assert.equal(classifyBrowserCall("browser_press", { key: "Enter" }, context({}, { focused: field }))?.kind, "outward");
  assert.equal(classifyBrowserCall("browser_press", { key: "Enter" }, context({}, { focused: { role: "button", name: "Go", unresolved: true } }))?.kind, "outward");
});

test("interactive elements past the read limit are treated as unknown, not as ordinary clicks", () => {
  const elements: Record<string, { role: string; name: string }> = {
    l1: { role: "link", name: "Docs" },
    t1: { role: "textbox", name: "Note" },
  };
  for (let index = 1; index <= 205; index += 1) elements[`b${index}`] = { role: "button", name: "Go" };
  const plan = enrichmentPlan(elements as never);
  assert.equal(plan.read.length, ENRICH_LIMIT);
  assert.equal(plan.unknown.length, 205 + 1 - ENRICH_LIMIT, "every interactive element past the limit is left unread");
  assert.equal(plan.unknown[0][0], "b200", "the first unread button is the one right after the limit");
  // A link needs no facts, so it is neither read nor treated as unknown (an unknown link would ask).
  assert.ok(!plan.read.some(([ref]) => ref === "l1") && !plan.unknown.some(([ref]) => ref === "l1"));
  // The worker marks the unread ones `unresolved`, and that is what makes approval ask.
  const element = { ...plan.unknown[0][1], unresolved: true };
  assert.equal(classifyBrowserCall("browser_click", { ref: "b200" }, context({ b200: element }))?.kind, "outward");
});

test("the egress proxy refuses private addresses, other ports and names that resolve privately", async () => {
  const denied: unknown[] = [];
  const proxy = await startEgressProxy({ log: (_event, fields) => denied.push(fields) });
  const connectTo = (target: string) => new Promise<string>((resolve) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (data) => { resolve(data.toString().split("\r\n")[0]); socket.destroy(); });
  });
  const get = (url: string) => new Promise<{ status: number; body: string }>((resolve) => {
    request({ host: "127.0.0.1", port: proxy.port, path: url, headers: { host: new URL(url).host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).end();
  });
  try {
    assert.match(await connectTo("127.0.0.1:443"), /403/);
    assert.match(await connectTo("169.254.169.254:443"), /403/);
    assert.match(await connectTo("10.0.0.1:443"), /403/);
    assert.match(await connectTo("localhost:443"), /403/, "a name resolving to loopback");
    assert.match(await connectTo("example.com:22"), /403/, "only 80 and 443");
    const page = await get("http://169.254.169.254/latest/meta-data/");
    assert.equal(page.status, 403);
    assert.match(page.body, /public websites/);
    assert.equal((await get("http://example.com:8080/")).status, 403);
    assert.ok(denied.length >= 7);
  } finally { await proxy.close(); }
});

test("a download never follows a link out of the workspace, and only a folder the bot made gets its mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "rtb-download-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: root, root: join(root, "ws") });
  const workspace = layout.agents.assistant;
  const secret = join(root, "private");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(secret, { mode: 0o700 });
  chmodSync(secret, 0o700);
  try {
    // Paths come back as the workspace's real path (macOS temp dirs live under /private).
    const real = realpathSync(workspace);
    const first = await saveWorkspaceDownload(layout, "assistant", "a.txt", Buffer.from("one"));
    assert.equal(first, join(real, "downloads", "a.txt"));
    assert.equal(statSync(join(workspace, "downloads")).mode & 0o7777, 0o2770);
    assert.equal(statSync(first).mode & 0o777, 0o660);
    assert.equal(await saveWorkspaceDownload(layout, "assistant", "a.txt", Buffer.from("two")), join(real, "downloads", "a (2).txt"), "never overwritten");
    // An agent swaps the folder for a link to a private directory: refused, nothing written or changed there.
    renameSync(join(workspace, "downloads"), join(workspace, "old-downloads"));
    symlinkSync(secret, join(workspace, "downloads"));
    await assert.rejects(saveWorkspaceDownload(layout, "assistant", "b.txt", Buffer.from("x")), /link/);
    assert.deepEqual(readdirSync(secret), []);
    assert.equal(statSync(secret).mode & 0o7777, 0o700);
    // A link in place of the file itself is refused too.
    rmSync(join(workspace, "downloads"));
    mkdirSync(join(workspace, "downloads"));
    symlinkSync(join(secret, "planted"), join(workspace, "downloads", "c.txt"));
    assert.equal(await saveWorkspaceDownload(layout, "assistant", "c.txt", Buffer.from("x")), join(real, "downloads", "c (2).txt"));
    assert.equal(existsSync(join(secret, "planted")), false);
    await assert.rejects(saveWorkspaceDownload(layout, "assistant", "../x", Buffer.from("x")), /Invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const shell = findHeadlessShell();

test("account discovery groups related sites without claiming an active login or revealing URL data", () => {
  const note = browserAccountNote(new Set([
    "https://accounts.google.com/", "https://www.youtube.com/", "https://www.reddit.com/",
    "https://x.com/", "https://twitter.com/", "https://github.com/", "https://icloud.com/",
    "https://user:secret@tenant.example.co.uk/private?token=private-token", "file:///private", "invalid",
    "https://one.github.io/", "https://two.github.io/",
  ]), { controller: "user", clearing: false });
  const data = JSON.parse(note.split("\n")[1]);
  assert.equal(data.controller, "user");
  assert.equal(data.accounts.length, 8);
  const google = data.accounts.find((a: { scope: string }) => a.scope === "google.com");
  assert.equal(google.service, "Google");
  assert.equal(google.status, "unverified", "takeover records survive sign-out; never report them as logged in");
  assert.deepEqual(google.origins, ["https://accounts.google.com", "https://www.youtube.com"]);
  assert.equal(data.accounts.filter((a: { scope: string }) => a.scope === "x.com").length, 1);
  assert.ok(!/secret|private-token|\/private\?/.test(note));
  assert.match(note, /may have signed out/);
  assert.match(note, /Only access private content the user requested/);
  assert.match(note, /browser_request_takeover/);
  assert.match(note, /Existing approval rules still apply/);
});

test("account discovery reads current host records without starting Chrome, and clears immediately", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-accounts-"));
  writeFileSync(join(dataDir, "browser.json"), JSON.stringify({ loggedIn: ["https://accounts.google.com"] }));
  const service = createBrowserService({ dataDir, executable: "/unused-test-chrome" });
  const tools = service.toolsFor({ conversationId: "c", agent: "assistant", saveDownload: async () => "", ask: async () => null })!;
  try {
    assert.ok(BROWSER_TOOL_SPECS.some(spec => spec.name === "browser_accounts"));
    const found = await tools.run("browser_accounts", {});
    assert.equal(found.isError, false);
    assert.equal(service.classify("browser_accounts", {})?.kind, "read");
    assert.match(found.text, /"service":"Google"/);
    assert.match(found.text, /"status":"unverified"/);
    assert.equal(service.view().running, false);
    assert.equal(found.text, service.contextNote());
    await service.stop();
    assert.match(service.contextNote(), /"service":"Google"/, "normal close retains the candidate");
    await service.clearLogins();
    assert.match((await tools.run("browser_accounts", {})).text, /"accounts":\[\]/);
    assert.match(service.contextNote(), /"accounts":\[\]/);
    assert.equal(service.view().running, false);
    const absent = createBrowserService({ dataDir, executable: "" });
    assert.equal(absent.contextNote(), "", "no misleading browser capability when unavailable");
  } finally {
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a stopped turn never runs the browser action it queued", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-cancel-"));
  // The install is irrelevant: the action must be refused before the browser is even started.
  const service = createBrowserService({ dataDir, executable: "/nonexistent/chrome-headless-shell" });
  const tools = service.toolsFor({ conversationId: "c", agent: "assistant", saveDownload: async () => "/tmp/unused", ask: async () => null })!;
  try {
    // The action was approved while it waited behind another one; the turn stopped before its turn came.
    const stopped = new AbortController();
    stopped.abort();
    const queued = await tools.run("browser_snapshot", {}, stopped.signal);
    assert.equal(queued.isError, true, "a stopped action is refused, not run");
    // Refused by the stop itself, not by a browser that was already being launched for it.
    assert.match(queued.text, /abort/i, queued.text);
    assert.equal(service.view().running, false, "the refused action never started the browser");
  } finally {
    await service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a real browser: snapshot refs, secret fields refused, takeover, per-site sign-in and downloads", { skip: !shell && "no Chromium headless shell installed" }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rtb-browser-"));
  const layout = resolveWorkspaceLayout({ fallbackCwd: dataDir, root: join(dataDir, "ws") });
  const workspace = layout.agents.assistant;
  mkdirSync(workspace, { recursive: true });
  const site: Server = createServer((req, res) => {
    if (req.url === "/login-status") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<p>${req.headers.cookie?.includes("test_login=1") ? "Signed in" : "Signed out"}</p>`); return; }
    res.setHeader("Set-Cookie", "test_login=1; Max-Age=3600; Path=/; HttpOnly");
    if (req.url === "/report.txt") { res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=report.txt" }); res.end("quarterly numbers\n"); return; }
    if (req.url === "/tool.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=tool.bin" }); res.end(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3])); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Shop</title><input aria-label="Pinned" style="position:absolute;left:0;top:0;width:300px;height:40px"><button type="button" style="position:absolute;left:320px;top:0" onclick="setTimeout(() => document.querySelector('[aria-label=Pinned]').focus(), 800)">Later</button><div style="height:60px"></div><form method="post" action="/order"><label>Note <input name="note"></label><label>Password <input type="password" name="pw"></label><button>Place order</button></form>
      <a href="/report.txt">Report</a> <a href="/tool.bin">Tool</a>
      <form method="get" action="/search"><label>Query <input name="q"></label><button formmethod="post">Continue</button></form>`);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const service = createBrowserService({ dataDir, allowAddress: (address) => address === "127.0.0.1", allowPort: (value) => value === port });
  const questions: string[] = [];
  const tools = service.toolsFor({ conversationId: "c", agent: "assistant", saveDownload: (name, bytes) => saveWorkspaceDownload(layout, "assistant", name, bytes), ask: async (asked) => { questions.push(asked[0].question); return { browser_takeover: ["已完成"] }; } })!;
  const ref = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];
  try {
    const opened = await tools.run("browser_open", { url: `http://127.0.0.1:${port}/` });
    assert.equal(opened.isError, false, opened.text);
    assert.match(opened.text, /Title: Shop/);
    const password = ref(opened.text, /textbox "Password" \[ref=([a-z0-9]+)\]/)!;
    const note = ref(opened.text, /textbox "Note" \[ref=([a-z0-9]+)\]/)!;
    const order = ref(opened.text, /button "Place order" \[ref=([a-z0-9]+)\]/)!;
    assert.equal(service.classify("browser_type", { ref: password, text: "x" })?.kind, "secret");
    assert.equal(service.classify("browser_click", { ref: order })?.kind, "outward");
    assert.equal(service.classify("browser_type", { ref: note, text: "x" })?.kind, "mutating");
    // A button's own `formmethod` overrides the form's: this GET form really posts.
    const query = ref(opened.text, /textbox "Query" \[ref=([a-z0-9]+)\]/)!;
    const cont = ref(opened.text, /button "Continue" \[ref=([a-z0-9]+)\]/)!;
    assert.equal(service.classify("browser_click", { ref: cont })?.kind, "outward");
    assert.equal(service.classify("browser_type", { ref: query, text: "x", submit: true })?.kind, "outward");
    // Even if a gate were bypassed, the worker refuses to type into the password field.
    const typed = await tools.run("browser_type", { ref: password, text: "hunter2" });
    assert.equal(typed.isError, true);
    assert.match(typed.text, /never type/);

    // The reported bypass: type into a field, Tab to a sending button, Enter. Judged on the focused button.
    await tools.run("browser_type", { ref: note, text: "hello" });
    const tabbed = await tools.run("browser_press", { key: "Tab" });
    assert.match(tabbed.text, /textbox "Password" \[active\]/, "Tab moved focus to the password field");
    await tools.run("browser_press", { key: "Tab" });
    assert.equal(service.classify("browser_press", { key: "Enter" })?.kind, "outward", "Enter on the focused Place order button");
    // Approved against the focused element in the snapshot; the page moves focus afterwards: refused.
    const later = ref((await tools.run("browser_snapshot", {})).text, /button "Later" \[ref=([a-z0-9]+)\]/)!;
    const clicked = await tools.run("browser_click", { ref: later });
    assert.match(clicked.text, /button "Later" \[active\]/);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const pressed = await tools.run("browser_press", { key: "Enter" });
    assert.equal(pressed.isError, true);
    assert.match(pressed.text, /Focus moved/);

    // Downloads: a text file lands in the workspace, a program does not.
    const seen = [(await tools.run("browser_click", { ref: ref(opened.text, /link "Report" \[ref=([a-z0-9]+)\]/) })).text,
      (await tools.run("browser_click", { ref: ref(opened.text, /link "Tool" \[ref=([a-z0-9]+)\]/) })).text];
    for (let i = 0; i < 50 && !existsSync(join(workspace, "downloads", "report.txt")); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readFileSync(join(workspace, "downloads", "report.txt"), "utf8"), "quarterly numbers\n");
    assert.equal(statSync(join(workspace, "downloads", "report.txt")).mode & 0o777, 0o660, "shared with the agents' group, never executable");
    assert.equal(statSync(join(workspace, "downloads")).mode & 0o7777, 0o2770);
    assert.deepEqual(readdirSync(join(workspace, "downloads")), ["report.txt"]);
    // Each note comes once, with whichever result follows the download.
    seen.push((await tools.run("browser_snapshot", {})).text);
    assert.match(seen.join("\n"), /Downloaded report\.txt/);
    assert.match(seen.join("\n"), /tool\.bin looks like a program/);

    // Takeover: agent actions wait for the user; afterwards the site counts as signed in.
    await service.takeover(`http://127.0.0.1:${port}/login`);
    assert.equal(service.view().url, `http://127.0.0.1:${port}/login`, "login shortcut navigates the remote browser");
    assert.equal(service.view().controller, "user");
    assert.match((await tools.run("browser_accounts", {})).text, /"controller":"user"/, "discovery is available during takeover");
    assert.match((await tools.run("browser_snapshot", {})).text, /user is controlling/);
    // The user's own clicks and text from the live view reach the page.
    await service.input({ kind: "mouse", type: "down", x: 50, y: 20, button: "left" });
    await service.input({ kind: "mouse", type: "up", x: 50, y: 20, button: "left" });
    await service.input({ kind: "text", text: "用户输入" });
    await service.input({ kind: "key", type: "down", key: "Backspace" });
    await service.input({ kind: "key", type: "up", key: "Backspace" });
    service.release();
    assert.ok((await tools.run("browser_accounts", {})).text.includes(`http://127.0.0.1:${port}`), "release refreshes account candidates for tools already held by an engine");
    assert.equal(service.view().controller, "agent");
    const again = await tools.run("browser_snapshot", {});
    assert.match(again.text, /textbox "Pinned"[^\n]*: 用户输/, again.text.slice(0, 400));
    const noteAgain = ref(again.text, /textbox "Note" \[ref=([a-z0-9]+)\]/)!;
    assert.deepEqual(service.classify("browser_type", { ref: noteAgain, text: "x" }), { kind: "connector", key: `browser_type@http://127.0.0.1:${port}` });
    assert.match(readFileSync(join(dataDir, "browser.json"), "utf8"), new RegExp(`127.0.0.1:${port}`));

    const takeover = await tools.run("browser_request_takeover", { reason: "请登录" });
    assert.deepEqual(questions, ["请登录"]);
    assert.match(takeover.text, /handed the browser back/);
    // Stopping ends Chrome itself, not just the worker: nothing keeps running on this profile.
    await service.stop();
    assert.equal(service.view().running, false);
    const left = (() => { try { return execFileSync("pgrep", ["-f", join(dataDir, "browser", "profile")], { encoding: "utf8" }).trim(); } catch { return ""; } })();
    assert.equal(left, "", "a browser process outlived stop()");
    assert.match((await tools.run("browser_open", { url: `http://127.0.0.1:${port}/login-status` })).text, /Signed in/, "closing preserves login cookies");
    await service.clearLogins();
    assert.equal(service.view().running, false);
    assert.equal(service.view().url, undefined);
    assert.equal(existsSync(join(dataDir, "browser", "profile")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "browser.json"), "utf8")), { loggedIn: [] });
    assert.match((await tools.run("browser_open", { url: `http://127.0.0.1:${port}/login-status` })).text, /Signed out/, "clearing removes login cookies after restart");
    assert.equal(service.classify("browser_type", { ref: "unknown", text: "x" })?.kind, "outward");
  } finally {
    await service.stop();
    site.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("login shortcuts accept Apple and custom web URLs, reject invalid destinations", () => {
  assert.equal(browserLoginUrl("apple"), "https://account.apple.com/sign-in");
  assert.equal(browserLoginUrl("other", "https://example.com/login"), "https://example.com/login");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com", "invalid", undefined]) {
    assert.throws(() => browserLoginUrl("other", url));
  }
  assert.throws(() => browserLoginUrl("__proto__"));
});

test("related login domains ask in auto mode, but always-allow stays on the exact origin", () => {
  let origin = "https://mail.google.com";
  const loggedIn = new Set(["https://accounts.google.com"]);
  const elements = { e1: { role: "link", name: "Inbox" }, e2: { role: "button", name: "Send message" }, e3: { role: "textbox", name: "Password", inputType: "password" } };
  const classify = (name: string, args: unknown) => classifyBrowserCall(name, args, context(elements, { origin, loggedIn }));
  const memory = new ApprovalMemory();
  const gate = new PiApprovalGate({ cwd: "/workspace", protectedPaths: [], hostCall: classify }, memory);
  gate.setAgent("assistant"); gate.setMode("auto");
  const call = { ref: "e1" };
  for (const site of ["https://mail.google.com", "https://www.google.com", "https://www.youtube.com"]) {
    origin = site;
    assert.deepEqual(classify("browser_click", call), { kind: "connector", key: `browser_click@${site}` });
    assert.equal(gate.requiresApproval("browser_click", call), true);
  }
  memory.add("assistant", "browser_click");
  assert.equal(gate.requiresApproval("browser_click", call), true, "an old generic grant cannot cover an account-scoped call");
  memory.add("assistant", "browser_click@https://www.google.com");
  origin = "https://www.google.com"; assert.equal(gate.requiresApproval("browser_click", call), false);
  origin = "https://mail.google.com"; assert.equal(gate.requiresApproval("browser_click", call), true);
  assert.equal(classify("browser_open", {})?.kind, "read");
  assert.equal(classify("browser_snapshot", {})?.kind, "read");
  assert.equal(classify("browser_click", { ref: "e2" })?.kind, "outward");
  assert.equal(classify("browser_type", { ref: "e3", text: "secret" })?.kind, "secret");

  for (const [login, target, expected] of [
    ["https://reddit.com", "https://www.reddit.com", "connector"],
    ["https://x.com", "https://twitter.com", "connector"],
    ["https://account.apple.com", "https://www.icloud.com", "connector"],
    ["https://login.example.co.uk", "https://app.example.co.uk", "connector"],
    ["https://a.github.io", "https://b.github.io", "mutating"],
    ["https://accounts.google.com", "https://google.com.attacker.example", "mutating"],
    ["https://accounts.google.com", "https://notgoogle.com", "mutating"],
    ["https://accounts.google.com", "https://github.com", "mutating"],
    ["http://127.0.0.1:1234", "http://127.0.0.1:5678", "mutating"],
  ]) {
    assert.equal(classifyBrowserCall("browser_click", call, context(elements, { origin: target, loggedIn: new Set([login]) }))?.kind, expected, `${login} → ${target}`);
  }
});
