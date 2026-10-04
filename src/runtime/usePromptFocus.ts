import { useLayoutEffect, useRef } from "react";

/** Removed controls must not leave keyboard focus on the document, or steal it from another view. */
export function restorePromptFocus(panel: HTMLElement, frame: HTMLElement, conversationId?: string) {
  const document = panel.ownerDocument, active = document.activeElement;
  if (!frame.isConnected || frame.dataset.conversationId !== conversationId) return;
  if (active && active !== document.body && active.isConnected && !panel.contains(active)) return;
  const target = frame.querySelector<HTMLElement>('[data-preview-region="approval-overlay"] strong[tabindex="-1"]')
    ?? frame.querySelector<HTMLTextAreaElement>('[data-preview-anchor="composer"] textarea');
  target?.focus({ preventScroll: true });
}

/** Shared by the existing question and approval surfaces; it never focuses a newly arriving prompt. */
export function usePromptFocus(pending: boolean) {
  const ref = useRef<HTMLElement>(null);
  const last = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const panel = ref.current, frame = panel?.closest<HTMLElement>(".preview-frame");
    if (!panel || !frame) return;
    const document = panel.ownerDocument, conversationId = frame.dataset.conversationId;
    const track = () => {
      const active = document.activeElement;
      // Disabling a pending control may move focus to body; an explicit move elsewhere releases ownership.
      if (active !== document.body) last.current = panel.contains(active) ? active as HTMLElement : null;
    };
    track();
    document.addEventListener("focusin", track);
    return () => {
      document.removeEventListener("focusin", track);
      if (last.current) queueMicrotask(() => restorePromptFocus(panel, frame, conversationId));
    };
  }, []);
  useLayoutEffect(() => {
    const element = last.current;
    if (!pending && element?.isConnected && element.ownerDocument.activeElement === element.ownerDocument.body)
      element.focus({ preventScroll: true });
  }, [pending]);
  return ref;
}
