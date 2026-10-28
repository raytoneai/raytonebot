import assert from "node:assert/strict";
import { test } from "node:test";
import { isCompositionKey, shouldSubmitComposer } from "./composerKeyboard.ts";

const enter = { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13 };

test("desktop Enter sends; touch Enter inserts a line; deliberate modifier sends on both", () => {
  assert.equal(shouldSubmitComposer(enter, false), true);
  assert.equal(shouldSubmitComposer(enter, true), false);
  for (const touch of [false, true]) {
    assert.equal(shouldSubmitComposer({ ...enter, ctrlKey: true }, touch), true);
    assert.equal(shouldSubmitComposer({ ...enter, metaKey: true }, touch), true);
    assert.equal(shouldSubmitComposer({ ...enter, shiftKey: true }, touch), false);
    assert.equal(shouldSubmitComposer({ ...enter, altKey: true }, touch), false);
    assert.equal(shouldSubmitComposer({ ...enter, key: "a" }, touch), false);
  }
});

test("IME confirmation never submits, including Safari's composition-ending Enter", () => {
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(isCompositionKey({ ...enter, ...composing }), true);
    for (const touch of [false, true]) {
      assert.equal(shouldSubmitComposer({ ...enter, ...composing }, touch), false);
      assert.equal(shouldSubmitComposer({ ...enter, metaKey: true, ...composing }, touch), false);
    }
  }
});
