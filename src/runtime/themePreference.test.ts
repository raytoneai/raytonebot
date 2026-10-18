import assert from "node:assert/strict";
import test from "node:test";
import { resolveThemePreset } from "../theme/themeTokens.ts";

test("retired palettes preserve the user's light or dark preference", () => {
  for (const id of ["soft-glass", "sand-workspace", "apricot-agent", "ice-white", "mist-blue", "polar-mono"]) {
    assert.equal(resolveThemePreset(id, "warm-graphite"), "soft-glass", id);
  }
  for (const id of ["warm-graphite", "cocoa-system", "forest-ember", "cold-mono", "slate-blue", "cyan-grid"]) {
    assert.equal(resolveThemePreset(id), "warm-graphite", id);
  }
});

test("missing and invalid preferences use the configured default, including prototype names", () => {
  for (const id of [undefined, "", "unknown", "constructor", "toString", "__proto__"]) {
    assert.equal(resolveThemePreset(id), "soft-glass");
    assert.equal(resolveThemePreset(id, "warm-graphite"), "warm-graphite");
  }
});
