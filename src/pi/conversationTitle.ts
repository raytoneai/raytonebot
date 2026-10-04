import type { PiProviderDefinition } from "./piClient.ts";
import { conversationTitle } from "./conversationStore.ts";

/**
 * A short title for a new conversation, summarized from its first message by the model service
 * the turn uses. Node-only. Best effort: any failure keeps the truncated-prompt title.
 */
const INSTRUCTION = "Write a short title for a conversation that starts with the user's message below. "
  + "Use the language of the message. At most 16 Chinese/Japanese characters or 8 words. "
  + "Output only the title: no quotes, no trailing punctuation, no explanation.";

export async function summarizeConversationTitle(
  definition: Pick<PiProviderDefinition, "baseUrl" | "protocol">,
  apiKey: string | undefined,
  model: string,
  prompt: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const base = definition.baseUrl.trim().replace(/\/+$/, "");
  const message = prompt.slice(0, 2000);
  const signal = AbortSignal.timeout(15_000);
  let text: unknown;
  if (definition.protocol === "openai-compatible") {
    const response = await fetcher(`${base}/chat/completions`, { method: "POST", signal,
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, max_tokens: 200, temperature: 0.3, stream: false,
        messages: [{ role: "system", content: INSTRUCTION }, { role: "user", content: message }] }) });
    if (!response.ok) return undefined;
    const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    text = body.choices?.[0]?.message?.content;
  } else if (definition.protocol === "anthropic") {
    const response = await fetcher(`${base}/messages`, { method: "POST", signal,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: JSON.stringify({ model, max_tokens: 200, system: INSTRUCTION, messages: [{ role: "user", content: message }] }) });
    if (!response.ok) return undefined;
    const body = await response.json() as { content?: { type?: string; text?: unknown }[] };
    text = body.content?.find((block) => block.type === "text")?.text;
  }
  return typeof text === "string" ? cleanTitle(text) : undefined;
}

export function cleanTitle(text: string): string | undefined {
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
  const title = line.replace(/^(title|标题|タイトル)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「」『』《》*#\s]+|["'“”‘’「」『』《》*\s。.!！?？,，;；:：]+$/g, "")
    .trim();
  return title ? conversationTitle(title) : undefined;
}
