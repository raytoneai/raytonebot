import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { DEFAULT_BOTS } from "./botAppearance.ts";

let server: ViteDevServer;
type ShellExtrasModule = typeof import("../components/shell/ShellExtras.tsx");
type ShellExtras = import("../components/shell/ShellExtras.tsx").ShellExtras;
let GroupHeader: ShellExtrasModule["GroupHeader"];
let GroupWelcome: ShellExtrasModule["GroupWelcome"];
let ShellExtrasProvider: ShellExtrasModule["ShellExtrasProvider"];
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  ({ GroupHeader, GroupWelcome, ShellExtrasProvider } = await server.ssrLoadModule("/src/components/shell/ShellExtras.tsx"));
});
after(async () => { await server?.close(); });

const customId = "bot_12345678-1234-1234-1234-123456789abc";
const avatars = { assistant: "woman", planner: "man", builder: "boy", dsh: "woman" } as const;
const render = (view: ReactElement, value: ShellExtras = {}) => renderToStaticMarkup(createElement(ShellExtrasProvider, { value, children: view }));

test("group header and welcome tolerate unknown historical IDs while retaining known labels", () => {
  const members = ["assistant", customId];
  const header = render(createElement(GroupHeader, { avatars, members, hostId: "assistant", draft: false, onChange() {} }));
  const welcome = render(createElement(GroupWelcome, { avatars, members, hostId: "assistant", onChange() {} }));
  for (const markup of [header, welcome]) {
    assert.match(markup, /Raer/);
    assert.ok(markup.includes(customId), "unknown member ID remains recognizable");
  }
});

test("group welcome uses historical catalog labels and disables the actual host in second position", () => {
  const members = ["assistant", customId];
  const bots = [
    { id: "assistant", presetId: "assistant" as const, name: "Old assistant", appearance: DEFAULT_BOTS.woman },
    { id: customId, presetId: "planner" as const, name: "Historical planner", appearance: DEFAULT_BOTS.man },
  ];
  const markup = render(createElement(GroupWelcome, { avatars, members, hostId: customId, onChange() {} }), { bots });
  assert.match(markup, /Old assistant/);
  assert.match(markup, /Historical planner/);
  const chips = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0])
    .filter(button => /^<button\b[^>]*class="shell-member-chip"/.test(button));
  const assistantChip = chips.find(button => button.includes("Old assistant"));
  const hostChip = chips.find(button => button.includes("Historical planner"));
  assert.ok(assistantChip);
  assert.ok(hostChip);
  const openingTag = (button: string) => button.slice(0, button.indexOf(">") + 1);
  assert.doesNotMatch(openingTag(assistantChip), /\bdisabled\b/);
  assert.match(openingTag(hostChip), /\bdisabled\b/);
});

test("group header and welcome remain safe with an empty catalog and only unknown IDs", () => {
  const members = [customId, "bot_22345678-1234-1234-1234-123456789abc"];
  const header = render(createElement(GroupHeader, { avatars, members, hostId: customId, draft: false, onChange() {} }), { bots: [] });
  const welcome = render(createElement(GroupWelcome, { avatars, members, hostId: customId, onChange() {} }), { bots: [] });
  for (const markup of [header, welcome]) {
    assert.ok(markup.includes(members[0]));
    assert.ok(markup.includes(members[1]));
  }
});
