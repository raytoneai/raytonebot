import { Transform } from "node:stream";
import type { ModelUsage, UsageTokens } from "./usageTypes.ts";

const LIMIT = 256 * 1024;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Reads only the usage object in a JSON response; long content strings are never retained. */
function jsonUsageReader(accept: (value: unknown) => void) {
  const stack: { object: boolean; path: string[]; key?: string; nextKey: boolean }[] = [];
  let inString = false, escaped = false, keyText = "", readingKey = false;
  let capture: string | undefined, captureDepth = 0, oversized = false, disabled = false;
  return (text: string) => {
    if (disabled) return;
    for (const char of text) {
      if (capture !== undefined && !oversized) {
        if (capture.length >= LIMIT) { capture = ""; oversized = true; }
        else capture += char;
      }
      if (inString) {
        if (readingKey && keyText.length < 128) keyText += char;
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === '"') {
          inString = false;
          if (readingKey) {
            const frame = stack.at(-1);
            if (frame) { try { frame.key = JSON.parse(`"${keyText}`); } catch { frame.key = undefined; } frame.nextKey = false; }
          }
        }
        continue;
      }
      if (char === '"') {
        inString = true; escaped = false; keyText = "";
        readingKey = Boolean(stack.at(-1)?.object && stack.at(-1)?.nextKey);
      } else if (char === "{" || char === "[") {
        const parent = stack.at(-1);
        const path = parent ? [...parent.path, parent.object ? parent.key ?? "" : "[]"] : [];
        if (stack.length >= 100) { disabled = true; stack.length = 0; capture = undefined; return; }
        stack.push({ object: char === "{", path, nextKey: char === "{" });
        if (char === "{" && capture === undefined && (path.join(".") === "usage" || path.join(".") === "response.usage" || path.join(".") === "message.usage")) {
          capture = "{"; captureDepth = stack.length; oversized = false;
        }
      } else if (char === "}" || char === "]") {
        if (capture !== undefined && stack.length === captureDepth) {
          if (!oversized) { try { accept(JSON.parse(capture)); } catch { /* Invalid usage is unknown. */ } }
          capture = undefined; oversized = false;
        }
        stack.pop();
      } else if (char === "," && stack.at(-1)?.object) {
        const frame = stack.at(-1)!; frame.nextKey = true; frame.key = undefined;
      }
    }
  };
}

/** Bounded, passive usage extraction. It neither rewrites model data nor keeps generated text. */
export function createModelUsageTracker(options: { protocol: "openai" | "anthropic"; contentType?: string }) {
  const sse = options.contentType?.toLowerCase().includes("text/event-stream") ?? false;
  const decoder = new TextDecoder();
  const tokens: UsageTokens = {};
  let anthropicInput: number | undefined;
  let finalUsage = !sse, line = "", data = "", skipLine = false, skipEvent = false, finished = false;
  let result: ModelUsage | undefined;
  const accept = (raw: unknown) => {
    const usage = record(raw);
    if (!usage) return;
    const set = (key: keyof UsageTokens, value: unknown) => { const known = count(value); if (known !== undefined) tokens[key] = known; };
    if (options.protocol === "anthropic") {
      const input = count(usage.input_tokens);
      if (input !== undefined) anthropicInput = input;
      set("outputTokens", usage.output_tokens);
      set("cacheReadTokens", usage.cache_read_input_tokens);
      set("cacheWriteTokens", usage.cache_creation_input_tokens);
      // Anthropic input_tokens excludes cache reads/writes; missing breakdowns stay absent.
      if (anthropicInput !== undefined) {
        const total = anthropicInput + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0);
        if (Number.isSafeInteger(total)) tokens.inputTokens = total;
      }
    } else {
      set("inputTokens", usage.prompt_tokens ?? usage.input_tokens);
      set("outputTokens", usage.completion_tokens ?? usage.output_tokens);
      const details = record(usage.prompt_tokens_details) ?? record(usage.input_tokens_details);
      set("cacheReadTokens", details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
      set("cacheWriteTokens", details?.cache_write_tokens);
      // OpenAI-compatible prompt/input totals already include the cache subsets.
      if (tokens.inputTokens !== undefined && tokens.outputTokens !== undefined) finalUsage = true;
    }
  };
  const json = jsonUsageReader(accept);
  const event = () => {
    if (!skipEvent && data.trim() && data.trim() !== "[DONE]") {
      try {
        const value = record(JSON.parse(data));
        if (value) {
          accept(value.usage ?? record(value.message)?.usage ?? record(value.response)?.usage);
          if (value.type === "message_stop") finalUsage = true;
        }
      } catch { /* Non-JSON notifications and malformed events do not supply usage. */ }
    }
    data = ""; skipEvent = false;
  };
  const acceptLine = () => {
    if (!skipLine) {
      const value = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!value) event();
      else if (!skipEvent && value.startsWith("data:")) {
        const payload = value.slice(5).replace(/^ /, "");
        if (data.length + payload.length + 1 > LIMIT) { data = ""; skipEvent = true; }
        else data += `${data ? "\n" : ""}${payload}`;
      }
    }
    line = ""; skipLine = false;
  };
  const writeText = (text: string) => {
    if (!sse) return json(text);
    for (const part of text.split(/(?<=\n)/)) {
      const newline = part.endsWith("\n");
      if (!skipLine) {
        if (line.length + part.length > LIMIT) { line = ""; data = ""; skipLine = true; skipEvent = true; }
        else line += newline ? part.slice(0, -1) : part;
      }
      if (newline) acceptLine();
    }
  };
  return {
    write(chunk: Uint8Array) { if (!finished) writeText(decoder.decode(chunk, { stream: true })); },
    finish(completed: boolean): ModelUsage {
      if (result) return { ...result };
      finished = true;
      writeText(decoder.decode());
      if (sse) { if (line) acceptLine(); if (data) event(); }
      const inputComplete = options.protocol !== "anthropic" || tokens.cacheReadTokens !== undefined && tokens.cacheWriteTokens !== undefined;
      result = { source: "gateway", ...tokens, complete: completed && finalUsage && inputComplete && tokens.inputTokens !== undefined && tokens.outputTokens !== undefined };
      return { ...result };
    },
  };
}

/** A single pipeline stage preserves bytes and normal Node stream backpressure. */
export function createModelUsageTap(options: Parameters<typeof createModelUsageTracker>[0]) {
  const tracker = createModelUsageTracker(options);
  let failed = false;
  return {
    stream: new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try { tracker.write(chunk); } catch { failed = true; }
      callback(null, chunk);
    } }),
    finish(completed: boolean) { return tracker.finish(completed && !failed); },
  };
}
