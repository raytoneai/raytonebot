export type ArtifactField = { id: string; label: string; type: "text" | "number" | "boolean" | "select"; required?: boolean; min?: number; max?: number; options?: string[] };
export type ArtifactForm = { kind: "raytone-form"; version: 1; title: string; prompt: string; fields: ArtifactField[] };
export type ArtifactValues = Record<string, string | number | boolean>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
export function parseArtifactForm(body: string): ArtifactForm | undefined {
  let value: unknown; try { value = JSON.parse(body); } catch { return; }
  if (!object(value) || value.kind !== "raytone-form") return;
  if (body.length > 24000 || value.version !== 1 || !text(value.title, 160) || !text(value.prompt, 2000) || !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 20) throw new Error("Invalid form schema / 表单结构无效");
  const ids = new Set<string>();
  for (const f of value.fields) {
    if (!object(f) || typeof f.id !== "string" || !/^[a-z][a-z0-9_]{0,39}$/i.test(f.id) || ["constructor", "prototype", "__proto__"].includes(f.id) || ids.has(f.id) || !text(f.label, 160) || !["text", "number", "boolean", "select"].includes(String(f.type)) || f.required !== undefined && typeof f.required !== "boolean") throw new Error("Invalid form field / 表单字段无效");
    ids.add(f.id);
    for (const key of ["min", "max"]) if (f[key] !== undefined && (f.type !== "number" || typeof f[key] !== "number" || !Number.isFinite(f[key]))) throw new Error("Invalid numeric bounds / 数字范围无效");
    if (typeof f.min === "number" && typeof f.max === "number" && f.min > f.max) throw new Error("Invalid numeric bounds / 数字范围无效");
    if (f.type === "select" && (!Array.isArray(f.options) || !f.options.length || f.options.length > 20 || f.options.some(v => !text(v, 100)) || new Set(f.options).size !== f.options.length)) throw new Error("Invalid options / 选项无效");
  }
  return value as unknown as ArtifactForm;
}
export function validateArtifactValues(form: ArtifactForm, raw: unknown): ArtifactValues {
  const result: ArtifactValues = {};
  if (!object(raw) || Object.keys(raw).some(key => !form.fields.some(f => f.id === key))) throw new Error("Unknown field / 未知字段");
  for (const field of form.fields) {
    const v = field.type === "boolean" && raw[field.id] === undefined ? false : raw[field.id];
    if (v === undefined || v === "") { if (field.required) throw new Error(`${field.label}: required / 必填`); continue; }
    const valid = field.type === "boolean" ? typeof v === "boolean" : field.type === "number" ? typeof v === "number" && Number.isFinite(v) && (field.min === undefined || v >= field.min) && (field.max === undefined || v <= field.max) : typeof v === "string" && v.length <= 1000 && (field.type !== "select" || field.options!.includes(v));
    if (!valid) throw new Error(`${field.label}: invalid value / 值无效`);
    result[field.id] = v as string | number | boolean;
  }
  return result;
}
export type ArtifactSubmission = { artifactId: string; submissionId: string };
export function validArtifactSubmission(value: unknown): value is ArtifactSubmission {
  return object(value) && text(value.artifactId, 1000) && typeof value.submissionId === "string" && /^form_[a-zA-Z0-9-]{1,80}$/.test(value.submissionId);
}
export function artifactSubmissionPrompt(form: ArtifactForm, values: ArtifactValues): string {
  const checked = validateArtifactValues(form, values);
  return `${form.prompt}\n\n${form.title}\n${form.fields.filter(field => checked[field.id] !== undefined).map(field => `${field.label}: ${String(checked[field.id])}`).join("\n")}`;
}

export type ArtifactFormDraft = { source: string; requestId: string; values: ArtifactValues; submitted?: boolean };
/** A changed document never inherits an old submission identity. Malformed saved input is ignored. */
export function restoreArtifactFormDraft(source: string, raw: string | null, createId = () => `form_${crypto.randomUUID()}`): ArtifactFormDraft {
  try {
    const record = raw ? JSON.parse(raw) : undefined;
    if (record?.source === source && /^form_[a-zA-Z0-9-]{1,80}$/.test(record.requestId) && object(record.values)) {
      const form = parseArtifactForm(source);
      if (form && JSON.stringify(record.values).length <= 22000 && Object.keys(record.values).every(key => form.fields.some(f => f.id === key)) && Object.values(record.values).every(v => typeof v === "string" && v.length <= 1000 || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v))) return { source, requestId: record.requestId, values: record.values, submitted: record.submitted === true };
    }
  } catch { /* Preserve the document, never automatically submit restored input. */ }
  return { source, requestId: createId(), values: {} };
}
