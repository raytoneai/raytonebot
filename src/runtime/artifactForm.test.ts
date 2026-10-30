import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArtifactForm, validateArtifactValues, restoreArtifactFormDraft, artifactSubmissionPrompt } from "./artifactForm.ts";
const source = JSON.stringify({ kind: "raytone-form", version: 1, title: "Budget", prompt: "Calculate", fields: [{ id: "amount", label: "Amount", type: "number", min: 0, max: 100, required: true }, { id: "unit", label: "Unit", type: "select", options: ["CNY", "USD"] }] });
test("structured schema and values are bounded; no coercion, unknown fields or invalid options", () => {
  const form = parseArtifactForm(source)!;
  assert.deepEqual(validateArtifactValues(form, { amount: 12.5, unit: "USD" }), { amount: 12.5, unit: "USD" });
  for (const values of [{}, { amount: "5" }, { amount: Infinity }, { amount: -1 }, { amount: 200 }, { amount: 4, unit: "EUR" }, { amount: 4, extra: "execute" }]) assert.throws(() => validateArtifactValues(form, values));
  assert.equal(parseArtifactForm('{"other":true}'), undefined);
  for (const fields of [Array(21).fill(form.fields[0]), [form.fields[0], form.fields[0]], [{ ...form.fields[0], id: "constructor" }], [{ ...form.fields[0], min: 5, max: 1 }]]) assert.throws(() => parseArtifactForm(JSON.stringify({ ...form, fields })));
});
test("refresh retains input and request identity but changed source cannot reuse an old submission", () => {
  const draft = restoreArtifactFormDraft(source, null, () => "form_abc");
  const saved = { ...draft, values: { amount: 12.5 }, submitted: true };
  assert.deepEqual(restoreArtifactFormDraft(source, JSON.stringify(saved)), saved);
  assert.equal(restoreArtifactFormDraft(source + " ", JSON.stringify(saved), () => "form_new").requestId, "form_new");
  assert.equal(restoreArtifactFormDraft(source, '{"bad":1}', () => "form_new").submitted, undefined);
  assert.match(artifactSubmissionPrompt(parseArtifactForm(source)!, saved.values), /Amount: 12.5/);
});

test("form validation uses the interface language and preserves author-supplied field names", () => {
  const form = parseArtifactForm(source)!;
  for (const [locale, required, invalid] of [["en", "required", "invalid value"], ["zh", "必填", "值无效"], ["ja", "必須です", "値が無効です"]] as const) {
    assert.throws(() => validateArtifactValues(form, {}, locale), error => error instanceof Error && error.message.includes("Amount") && error.message.includes(required));
    assert.throws(() => validateArtifactValues(form, { amount: -1 }, locale), error => error instanceof Error && error.message.includes(invalid));
  }
  assert.throws(() => parseArtifactForm('{"kind":"raytone-form"}', "ja"), /フォームの構造が無効です/);
});
