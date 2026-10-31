import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { createAgentUXViewModel, type AgentUXViewModel } from "@agent-ux/render-core";
import type { AppLocale } from "../i18n/locales.ts";

let server: ViteDevServer;
const modules: Record<string, any> = {};
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  for (const path of ["components/agent-preview/ChatFrame", "components/agent-preview/ToolCallCard", "components/agent-preview/outputframe/OutputPanelModal", "components/agent-preview/outputframe/OutputTabs", "agentmatrix/IconSetContext", "i18n/LocaleContext", "i18n/uiCopy", "exported-project"]) {
    Object.assign(modules, await server.ssrLoadModule(`/src/${path}`));
  }
});
after(async () => { await server?.close(); });

const locales: AppLocale[] = ["en", "zh", "ja"];
const render = (view: ReactElement, locale: AppLocale) => renderToStaticMarkup(createElement(modules.IconSetProvider, null,
  createElement(modules.LocaleProvider, { initialLocale: locale }, view)));
function renderError(viewModel: AgentUXViewModel, locale: AppLocale, collapse = false) {
  const project = { ...modules.project, blocks: { ...modules.project.blocks, errorCollapse: collapse } };
  const html = render(createElement(modules.ChatFrame, { project, previewPrompt: "", viewModel }), locale);
  const article = html.match(/<article class="error-item"[\s\S]*?<\/article>/)?.[0];
  assert.ok(article, "the existing error surface renders");
  return article;
}
const errorView = (payload: Record<string, unknown>) => createAgentUXViewModel([{
  protocol: "agent-ux", version: "0.1", id: "error", runId: "error-test", seq: 1, ts: 0, type: "run.error", payload,
}]);

test("the error fixture leads with its user message and keeps diagnostics behind a closed disclosure in every locale", async () => {
  const source = await readFile(new URL("../fixtures/agentux/block-error.events.jsonl", import.meta.url), "utf8");
  const events = source.trim().split("\n").map((line) => JSON.parse(line));
  const view = createAgentUXViewModel(events);
  const before = structuredClone(view);
  for (const locale of locales) {
    const copy = modules.uiCopy[locale].chat.error;
    const html = renderError(view, locale);
    const [primary, details] = html.split('<details class="error-details">');
    assert.ok(primary.includes(`<strong>${copy.writeFileTitle}</strong>`));
    assert.ok(primary.includes("<p>Could not write the generated file.</p>"));
    assert.doesNotMatch(primary, /E_WRITE_FILE|EACCES/);
    assert.ok(details.includes(`<summary>${copy.technicalDetails}</summary>`));
    assert.match(details, /<code>E_WRITE_FILE<\/code>/);
    assert.match(details, /EACCES: permission denied, open \/repo\/src\/SearchInput.tsx/);
    assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
    assert.match(html, /data-anim="spin"/);
  }
  assert.deepEqual(view, before, "presentation does not alter retryability or the event projection");
});

test("unknown errors retain their original message without inventing recovery guidance, including collapsed mode", () => {
  const view = errorView({ code: "E_UNFAMILIAR", userMessage: " ", message: "Unexpected provider response: 471", developerMessage: "trace: upstream closed", retryable: false });
  for (const locale of locales) {
    const copy = modules.uiCopy[locale].chat.error;
    for (const collapse of [false, true]) {
      const html = renderError(view, locale, collapse);
      assert.ok(html.includes(`<strong>${copy.title}</strong><p>Unexpected provider response: 471</p>`));
      assert.match(html, /data-anim="none"/);
      if (collapse) {
        assert.doesNotMatch(html, /<details|E_UNFAMILIAR|trace: upstream closed/);
        assert.ok(html.includes(`<small>${copy.debugHidden}</small>`));
      } else {
        assert.match(html, /<code>E_UNFAMILIAR<\/code>/);
        assert.match(html, /<p>trace: upstream closed<\/p>/);
      }
    }
  }
});

test("details preserve the raw message when developerMessage is absent and omit duplicate body text", () => {
  for (const developerMessage of [undefined, "   ", "socket reset at step 2"]) {
    const html = renderError(errorView({ code: "E_UNKNOWN", userMessage: "Could not finish this action.", message: "socket reset at step 2", developerMessage }), "en");
    assert.match(html, /<p>Could not finish this action\.<\/p><details/);
    assert.match(html, /<details[\s\S]*<p>socket reset at step 2<\/p>/);
  }
  const duplicate = renderError(errorView({ code: "E_UNKNOWN", userMessage: "Original error text", message: "Original error text", developerMessage: " Original error text " }), "en");
  assert.equal(duplicate.split("Original error text").length - 1, 1);
  const missingUserMessage = renderError(errorView({ code: "E_UNKNOWN", message: "No user message was supplied." }), "en");
  assert.match(missingUserMessage, /<p>No user message was supplied\.<\/p><details/);
  assert.equal(missingUserMessage.split("No user message was supplied.").length - 1, 1);
});

test("retry, exhausted, terminal and history errors keep their state-specific titles and retry animation", () => {
  for (const locale of locales) {
    const copy = modules.uiCopy[locale];
    for (const category of ["retrying", "exhausted", "terminal"] as const) {
      const view = errorView({ code: "E_WRITE_FILE", category, userMessage: "Original incident guidance", developerMessage: "Incident diagnostic", retryable: category === "retrying" });
      const before = structuredClone(view);
      const html = renderError(view, locale);
      assert.ok(html.includes(`<strong>${copy.chat.error.incident[category]}</strong><p>Original incident guidance</p>`));
      if (category === "retrying") assert.match(html, /data-anim="(?:spin|timer-hand|retry-rotate|hourglass)"/);
      else assert.match(html, /data-anim="none"/);
      assert.deepEqual(view, before);
    }
    const history = renderError(errorView({ code: "history_load_failed", category: "terminal", userMessage: copy.workspace.sessionSidebar.historyFailed }), locale);
    assert.ok(history.includes(`<strong>${copy.workspace.sessionSidebar.historyTitle}</strong>`));
    assert.ok(history.includes(`<p>${copy.workspace.sessionSidebar.historyFailed}</p>`));
  }
});

test("tool disclosures, output close and opened output tabs use localized accessible names", () => {
  const items = [{ id: "one", kind: "file", title: "one.txt", body: "One" }, { id: "two", kind: "file", title: "two.txt", body: "Two" }];
  const project = { ...modules.project, theme: { ...modules.project.theme, motion: { ...modules.project.theme.motion, toolCall: "card" } }, toolCalls: { ...modules.project.toolCalls, timelineRail: false, detail: "full" } };
  for (const locale of locales) {
    const copy = modules.uiCopy[locale];
    for (const open of [false, true]) {
      const tool = { kind: "tool", id: "tool", name: "check", status: "success", args: { input: "test" }, result: "Done", open };
      const html = render(createElement(modules.ToolCallCard, { project, tool }), locale);
      assert.ok(html.includes(`aria-label="${open ? copy.chat.toolCard.collapse : copy.chat.toolCard.expand}"`));
      assert.ok(html.includes(`aria-expanded="${open}"`));
    }
    const tabs = render(createElement(modules.OutputTabs, { items, activeId: "one" }), locale);
    assert.ok(tabs.includes(`role="tablist" aria-label="${copy.workspace.outputFrame.openedOutput}"`));
    const modal = render(createElement(modules.OutputPanelModal, { items, activeId: "one", onClose() {} }), locale);
    assert.ok(modal.includes(`aria-label="${copy.workspace.outputFrame.closeOutput}"`));
    assert.ok(modal.includes(`role="tablist" aria-label="${copy.workspace.outputFrame.openedOutput}"`));
  }
});
