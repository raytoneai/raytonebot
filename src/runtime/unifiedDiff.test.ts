import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeUnifiedDiff, replacementDiff, unifiedDiffLines } from "./unifiedDiff.ts";

test("diff detection requires headers and a hunk, not prose or Markdown rules", () => {
  assert.equal(looksLikeUnifiedDiff("--- summary\n+++ update\nordinary prose"), false);
  assert.equal(looksLikeUnifiedDiff("---\ntitle: document\n---"), false);
  assert.equal(looksLikeUnifiedDiff("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"), true);
});

test("multiple files, zero-length hunks and header-like source lines retain their meaning and exact text", () => {
  const source = "--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n--- old source\r\n+++ new source\r\n\\ No newline at end of file\r\n--- /dev/null\n+++ b/b\n@@ -0,0 +1,2 @@\n+first\n+second";
  const lines = unifiedDiffLines(source);
  assert.equal(lines.map((line) => line.text).join(""), source);
  assert.deepEqual(lines.map((line) => line.kind), ["header", "header", "hunk", "delete", "add", "context", "header", "header", "hunk", "add", "add"]);
});

test("replacement snippets preserve unchanged edges, empty files and final-newline differences", () => {
  for (const [before, after] of [["head\nold\ntail\n", "head\nnew\ntail\n"], ["", "new\n"], ["old", ""], ["same", "same\n"], ["a\r\nb\r\n", "a\r\nc\r\n"], ["same", "same"], ["", ""]]) {
    const patch = replacementDiff(before, after, "path\nwith space.ts");
    assert.equal(looksLikeUnifiedDiff(patch), true);
    const lines = unifiedDiffLines(patch);
    // Reconstruct both sides, including the no-newline marker, to catch lost/duplicated text.
    for (const [kind, expected] of [["delete", before], ["add", after]]) {
      let result = "";
      let included = false;
      for (const line of lines) {
        if (line.text.startsWith("\\ No newline")) {
          if (included) result = result.slice(0, -1);
        } else {
          included = line.kind === kind || line.kind === "context" && line.text.startsWith(" ");
          if (included) result += line.text.slice(1);
        }
      }
      assert.equal(result, expected);
    }
  }
});
