import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import postcss from "postcss";

const baselineCommit = "0d8faf6";
const source = "src/styles/app.css";
const folder = new URL("./", import.meta.url);
const audit = JSON.parse(readFileSync(new URL("worker-audit.json", folder), "utf8"));
const approved = JSON.parse(readFileSync(new URL("approved-removals.json", folder), "utf8"));
assert.deepEqual(audit.finalRuleRemovals.map(({ startLine, selector }) => ({ startLine, selector })), approved.rules);
assert.deepEqual(audit.finalKeyframeRemovals, approved.keyframes);
const before = execFileSync("git", ["show", `${baselineCommit}:${source}`], { encoding: "utf8" });
const after = readFileSync(source, "utf8");
const expected = postcss.parse(before);
const actual = postcss.parse(after);
const rules = new Map(audit.finalRuleRemovals.map((rule) => [rule.startLine, rule.selector]));
const keyframes = new Map(audit.finalKeyframeRemovals.map((rule) => [rule.startLine, rule.name]));
let removedRules = 0;
let removedKeyframes = 0;
expected.walkRules((rule) => {
  if (!rules.has(rule.source.start.line)) return;
  assert.equal(rule.selector, rules.get(rule.source.start.line));
  rule.remove();
  removedRules++;
});
expected.walkAtRules("keyframes", (rule) => {
  if (!keyframes.has(rule.source.start.line)) return;
  assert.equal(rule.params, keyframes.get(rule.source.start.line));
  rule.remove();
  removedKeyframes++;
});
assert.equal(removedRules, rules.size);
assert.equal(removedKeyframes, keyframes.size);

function normalize(node) {
  if (node.type === "comment") return null;
  const children = node.nodes?.map(normalize).filter(Boolean);
  if (node.type === "atrule" && children?.length === 0) return null;
  if (node.type === "decl") return [node.type, node.prop, node.value, Boolean(node.important)];
  if (node.type === "rule") return [node.type, node.selector, children];
  if (node.type === "atrule") return [node.type, node.name, node.params, children];
  return [node.type, children];
}
assert.deepEqual(normalize(actual), normalize(expected));
for (const name of keyframes.values()) assert(!after.includes(name), `Remaining animation reference: ${name}`);
const comments = (css) => {
  const records = [];
  postcss.parse(css).walkComments((node) => records.push(node.text));
  return { count: records.length, bytes: Buffer.byteLength(records.join("")) };
};
const metrics = (css) => ({ bytes: Buffer.byteLength(css), lines: css.split("\n").length - 1, comments: comments(css) });
const result = {
  baselineCommit,
  removedRules,
  removedKeyframes: [...keyframes.values()],
  retainedSelectorsDeclarationsOrderAndAtRuleContextsIdentical: true,
  before: metrics(before),
  after: metrics(after),
};
writeFileSync(new URL("review.json", folder), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
