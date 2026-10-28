import { useEffect, type RefObject } from "react";

/** The existing drawer owns its focus; nested portals keep their own keyboard handling. */
export function useCompactDrawer(ref: RefObject<HTMLDivElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    const drawer = ref.current;
    if (!open || !drawer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => [...drawer.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
    )].filter(element => element.getClientRects().length && !element.closest('[inert], [hidden]'));
    const focusFrame = requestAnimationFrame(() => (controls()[0] ?? drawer).focus({ preventScroll: true }));
    const onKey = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !drawer.contains(event.target)) return;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const nested = (event.target as HTMLElement).closest('[role="menu"], [role="dialog"], [role="alertdialog"]');
      if (nested && nested !== drawer) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (!first || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey);
      // Selecting a conversation or opening a dialog may already have moved focus.
      if (previous?.isConnected && (drawer.contains(document.activeElement) || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [ref, open, close]);
}
