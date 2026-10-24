import assert from "node:assert/strict";
import test from "node:test";
import { readOutputPanelLayout, saveOutputPanelLayout } from "./outputPanelLayout.ts";

test("output width survives remounts while invalid saved layouts fall back to defaults", () => {
  let saved: string | null = null;
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  assert.equal(readOutputPanelLayout(storage), undefined);
  saveOutputPanelLayout({ main: 60, output: 40 }, storage);
  assert.deepEqual(readOutputPanelLayout(storage), { main: 60, output: 40 });
  for (const invalid of ["broken", "null", "[]", '{"main":60}', '{"main":60,"output":30}',
    '{"main":-10,"output":110}', '{"main":"60","output":40}', '{"main":60,"output":40,"old":0}']) {
    saved = invalid;
    assert.equal(readOutputPanelLayout(storage), undefined, invalid);
  }
});

test("blocked browser storage does not break opening or resizing output", () => {
  const storage = { getItem: (): string => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readOutputPanelLayout(storage), undefined);
  assert.doesNotThrow(() => saveOutputPanelLayout({ main: 56, output: 44 }, storage));
});
