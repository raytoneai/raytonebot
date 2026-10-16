import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "./store.ts";

test("a claim is one check-and-create, so a second one returns the same bot", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-claim-"));
  const store = new Store(dir);
  const first = store.claim("u", 1000);
  assert.equal(first.created, true);
  assert.equal(first.bot.owner, "u");
  // The race that created two sandboxes: both requests read "no bot" before either created one.
  const second = store.claim("u", 2000);
  assert.equal(second.created, false, "the second claim adopts the existing bot");
  assert.equal(second.bot.id, first.bot.id);
  assert.equal(store.list().length, 1);
  // A different owner still gets their own bot.
  assert.equal(store.claim("other", 3000).created, true);
  assert.equal(store.list().length, 2);
  assert.equal(statSync(join(dir, "store.json")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "store.json"), "utf8")).bots.map((bot: { owner: string }) => bot.owner), ["u", "other"]);
});

test("a claim survives a reload without making a second bot", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-claim-"));
  const first = new Store(dir).claim("u", 1000).bot;
  const reopened = new Store(dir).claim("u", 2000);
  assert.equal(reopened.created, false);
  assert.equal(reopened.bot.id, first.id);
  assert.equal(reopened.bot.status, "provisioning");
});
