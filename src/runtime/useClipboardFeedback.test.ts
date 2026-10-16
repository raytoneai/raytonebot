import assert from "node:assert/strict";
import test from "node:test";
import { copyText } from "./useClipboardFeedback.ts";

type Fake = { write: number; focus: number; command: number };

/**
 * The browser APIs copyText reaches for. `clipboard: "deny"` is what an unfocused or hidden
 * document gets; `focusRescues: true` is a window that had merely lost focus.
 */
function fakeBrowser(options: { clipboard: "ok" | "deny"; focusRescues?: boolean; command?: boolean | "throw" }): Fake {
  const calls: Fake = { write: 0, focus: 0, command: 0 };
  let remainingFailures = options.clipboard === "ok" ? 0 : options.focusRescues ? 1 : Number.POSITIVE_INFINITY;
  const area = { value: "", style: { cssText: "" }, setAttribute() {}, select() {}, remove() {} };
  // `navigator` is a getter-only global, so the fakes are installed with defineProperty.
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", { focus: () => { calls.focus += 1; } });
  define("document", {
    createElement: () => area,
    body: { appendChild() {} },
    execCommand: () => {
      calls.command += 1;
      if (options.command === "throw") throw new Error("execCommand refused");
      return options.command === true;
    },
  });
  define("navigator", {
    clipboard: {
      writeText: async () => {
        calls.write += 1;
        if (remainingFailures > 0) { remainingFailures -= 1; throw new DOMException("Document is not focused", "NotAllowedError"); }
      },
    },
  });
  return calls;
}

test("the async Clipboard API is the first and only attempt when it works", async () => {
  const calls = fakeBrowser({ clipboard: "ok" });
  assert.equal(await copyText("hello"), "clipboard");
  assert.equal(calls.write, 1);
  assert.equal(calls.focus, 0, "a working write never asks for focus");
  assert.equal(calls.command, 0, "and never touches the legacy path");
});

test("a window that only lost focus is rescued by asking for it", async () => {
  const calls = fakeBrowser({ clipboard: "deny", focusRescues: true });
  assert.equal(await copyText("hello"), "clipboard");
  assert.equal(calls.focus, 1);
  assert.equal(calls.write, 2);
  assert.equal(calls.command, 0);
});

test("a refused async API still copies through the legacy command", async () => {
  const calls = fakeBrowser({ clipboard: "deny", command: true });
  assert.equal(await copyText("hello"), "command");
  assert.equal(calls.command, 1);
});

test("every path failing is reported as failed, never as copied", async () => {
  const refused = fakeBrowser({ clipboard: "deny", command: false });
  assert.equal(await copyText("hello"), "failed");
  const throwing = fakeBrowser({ clipboard: "deny", command: "throw" });
  assert.equal(await copyText("hello"), "failed", "a throwing legacy command must not escape");
});
