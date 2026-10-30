export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown Pi error");
}

export function normalizeConversationId(value: string | undefined): string {
  const id = value?.trim();
  if (!id) return "default";
  if (id === "." || id === ".." || id.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(id)) {
    throw new Error("Pi conversationId is invalid.");
  }
  return id;
}
