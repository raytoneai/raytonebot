/** Optional capabilities supplied by the user; no catalog guesses or pricing overrides. */
export type ModelOptions = {
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
};

const MAX_TOKEN_LIMIT = 10_000_000;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const modelName = (value: string): boolean => Boolean(value.trim()) && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const tokenLimit = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_TOKEN_LIMIT;

function validateOptions(value: unknown): ModelOptions {
  if (!record(value) || Object.keys(value).some(key => !["contextWindow", "maxTokens", "input", "reasoning"].includes(key))) {
    throw new Error("Invalid model options fields.");
  }
  const { contextWindow, maxTokens, input, reasoning } = value;
  if ((contextWindow !== undefined && !tokenLimit(contextWindow)) || (maxTokens !== undefined && !tokenLimit(maxTokens))) {
    throw new Error(`Model token limits must be whole numbers from 1 to ${MAX_TOKEN_LIMIT}.`);
  }
  if (input !== undefined && (!Array.isArray(input) || !input.includes("text") || input.length > 2
    || new Set(input).size !== input.length || input.some(item => item !== "text" && item !== "image"))) {
    throw new Error("Model input must include text and may also include image.");
  }
  if (reasoning !== undefined && typeof reasoning !== "boolean") throw new Error("Model reasoning must be a boolean.");
  if (maxTokens !== undefined && Number(maxTokens) > Number(contextWindow ?? 128_000)) {
    throw new Error("Model maxTokens cannot exceed contextWindow (128000 when omitted).");
  }
  return {
    ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
    ...(maxTokens !== undefined ? { maxTokens: maxTokens as number } : {}),
    ...(input !== undefined ? { input: [...input as ("text" | "image")[]] } : {}),
    ...(reasoning !== undefined ? { reasoning: reasoning as boolean } : {}),
  };
}

/** Reject malformed, misspelled or orphaned metadata before saving or registering a provider. */
export function normalizeModelOptions(value: unknown, models?: readonly string[]): Record<string, ModelOptions> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).length > 1000) throw new Error("Invalid model options map.");
  const known = models ? new Set(models.map(model => model.trim())) : undefined;
  const seen = new Set<string>();
  return Object.fromEntries(Object.entries(value).map(([key, options]) => {
    const id = key.trim();
    if (!modelName(key) || seen.has(id) || (known && !known.has(id))) throw new Error("Invalid or unknown model options ID.");
    seen.add(id);
    return [id, validateOptions(options)];
  }));
}

/** The previous registration defaults remain in effect for every omitted capability. */
export function resolveModelOptions(
  model: string,
  options: Record<string, ModelOptions> | undefined,
  fallbackReasoning = false,
): Required<ModelOptions> {
  const value = validateOptions(options && Object.hasOwn(options, model) ? options[model] : {});
  const contextWindow = value.contextWindow ?? 128_000;
  return {
    contextWindow,
    maxTokens: value.maxTokens ?? Math.min(16_384, contextWindow),
    input: value.input ?? ["text", "image"],
    reasoning: value.reasoning ?? fallbackReasoning,
  };
}
