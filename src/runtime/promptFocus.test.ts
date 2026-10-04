import assert from "node:assert/strict";
import test from "node:test";
import { restorePromptFocus } from "./usePromptFocus.ts";

test("removed prompts return focus only in the original conversation without displacing another control", () => {
  let focused = "", nextPrompt = false;
  const body = { isConnected: true }, detached = { isConnected: false }, input = { isConnected: true };
  const document = { body, activeElement: body };
  const panel = { ownerDocument: document, contains: (element: unknown) => element === detached };
  const frame = { isConnected: true, dataset: { conversationId: "original" },
    querySelector: (selector: string) => selector.includes("approval-overlay")
      ? nextPrompt ? { focus: () => { focused = "next-prompt"; } } : null
      : { focus: () => { focused = "composer"; } } };
  const restore = () => restorePromptFocus(panel as unknown as HTMLElement, frame as unknown as HTMLElement, "original");
  restore(); assert.equal(focused, "composer");
  focused = ""; document.activeElement = input; restore(); assert.equal(focused, "", "keep the control the user moved to");
  document.activeElement = body; frame.dataset.conversationId = "another"; restore(); assert.equal(focused, "", "late cleanup cannot focus another conversation");
  frame.dataset.conversationId = "original"; frame.isConnected = false; restore(); assert.equal(focused, "");
  frame.isConnected = true; document.activeElement = detached; nextPrompt = true; restore(); assert.equal(focused, "next-prompt");
});
