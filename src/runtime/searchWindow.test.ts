import test from "node:test";
import assert from "node:assert/strict";
import { anchoredScrollTop, searchLayout, visibleSearchRows } from "./useSearchWindow.ts";
import { searchResultKey } from "./useConversationSearch.ts";

test("search windows preserve variable-height group positions and a remote focused row without mounting intervening hits", () => {
  const items = Array.from({ length: 2500 }, (_, i) => ({ id: `conversation-${i}`, title: `Message ${i}`, textId: "shared", snippet: "match" }));
  const heights = new Map([[searchResultKey(items[0]), 120], [searchResultKey(items[1]), 36]]);
  const groups = searchLayout([items.slice(0, 2), items.slice(2)], heights);
  assert.equal(groups[0].height, 186);
  assert.equal(groups[1].rows[0].top, 220);
  assert.equal(groups[1].rows[0].offset, 26);
  assert.equal(groups[1].rows[0].index, 2);
  const rows = groups.flatMap(group => group.rows), focused = searchResultKey(items[2499]);
  const visible = visibleSearchRows(rows, 0, 400, focused);
  assert(visible.length < 15);
  assert.equal(visible.at(-1)?.key, focused);
  assert.equal(new Set(visible.map(row => row.key)).size, visible.length);
  assert(!visible.some(row => row.index === 1000));
  const middle = visibleSearchRows(rows, rows[1000].top, 400);
  assert(middle.some(row => row.index === 1000));
  assert(middle.length < 20);
  assert.deepEqual(searchLayout([[], []], heights).map(group => group.height), [0, 0]);
  assert.equal(searchLayout([[], [items[0]]], heights)[1].rows[0].top, 26);
});

test("history uses its own row spacing and can reach all 10000 sessions with or without date headings", () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({ id: `history-${i}`, title: `History ${i}` }));
  const metrics = { heading: 20, rowGap: 3, groupGap: 16, rowHeight: 34 };
  const groups = searchLayout([items.slice(0, 4), items.slice(4)], new Map(), metrics);
  assert.equal(groups[0].rows[0].top, 20);
  assert.equal(groups[0].rows[1].top, 57);
  assert.equal(groups[1].rows[0].top, 204);
  const rows = groups.flatMap(group => group.rows), last = rows.at(-1)!;
  assert.equal(last.index, 9999);
  assert(visibleSearchRows(rows, last.top - 300, 348).some(row => row.key === last.key));
  assert(visibleSearchRows(rows, last.top - 300, 348).length < 25);
  assert.equal(searchLayout([items], new Map(), { ...metrics, heading: 0 })[0].rows[0].top, 0);
  const updated = searchLayout([[{ id: "new-draft", title: "New draft" }, ...items.slice(0, 4)], items.slice(4)], new Map(), metrics).flatMap(group => group.rows);
  const top = rows[50].top + 7;
  assert.equal(anchoredScrollTop(rows, updated, top), top + 37, "prepending keeps the same row and within-row offset");
  assert.equal(anchoredScrollTop(rows, updated, 0), 0, "at the top, newly added sessions stay visible");
  assert.equal(anchoredScrollTop(rows, rows, top), top);
});
