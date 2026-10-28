type ComposerKey = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">;

/** Safari can end composition before its confirming Enter's keydown. */
export function isCompositionKey(event: Pick<ComposerKey, "isComposing" | "keyCode">) {
  return event.isComposing || event.keyCode === 229;
}

export function shouldSubmitComposer(event: ComposerKey, touchKeyboard: boolean) {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || isCompositionKey(event)) return false;
  return event.ctrlKey || event.metaKey || !touchKeyboard;
}
