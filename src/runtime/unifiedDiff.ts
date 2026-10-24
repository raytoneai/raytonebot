export type DiffLineKind = "context" | "add" | "delete" | "header" | "hunk";

/** Require a hunk as well as file headers; ordinary Markdown separators aren't patches. */
export function looksLikeUnifiedDiff(text: string): boolean {
  return /^--- .+\r?\n\+\+\+ .+\r?\n@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
}

/** Preserve the original text (including line endings) for selection and copying. */
export function unifiedDiffLines(text: string): { text: string; kind: DiffLineKind }[] {
  let oldRemaining = 0;
  let newRemaining = 0;
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text) => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    let kind: DiffLineKind = "context";
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      kind = "hunk";
    } else if (oldRemaining > 0 || newRemaining > 0) {
      // A removed source line can itself start with '-- '; it is not a file header.
      if (text.startsWith("-") && oldRemaining > 0) { kind = "delete"; oldRemaining--; }
      else if (text.startsWith("+") && newRemaining > 0) { kind = "add"; newRemaining--; }
      else if (text.startsWith(" ")) { oldRemaining--; newRemaining--; }
    } else if (/^(diff --git |index |--- |\+\+\+ |(?:new|deleted) file mode |(?:old|new) mode |rename |similarity index |Binary files )/.test(text)) {
      kind = "header";
    }
    return { text, kind };
  });
}

/** A replacement snippet, not a full-file patch: hunk positions are snippet-relative. */
export function replacementDiff(oldCode: string, newCode: string, path?: string): string {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(oldCode);
  const after = lines(newCode);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const emit = (sign: string, line: string) => `${sign}${line}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
  // Quote paths so a newline in a filename cannot create a fake hunk/header.
  const name = path ? JSON.stringify(path) : "snippet";
  return `--- ${name}\n+++ ${name}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n`
    + before.slice(0, prefix).map((line) => emit(" ", line)).join("")
    + before.slice(prefix, before.length - suffix).map((line) => emit("-", line)).join("")
    + after.slice(prefix, after.length - suffix).map((line) => emit("+", line)).join("")
    + before.slice(before.length - suffix).map((line) => emit(" ", line)).join("");
}
