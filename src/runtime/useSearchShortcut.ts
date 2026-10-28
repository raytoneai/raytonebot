import { useEffect, useEffectEvent, type RefObject } from "react";

export function useSearchShortcut(sidebar: RefObject<HTMLElement | null>, enabled: boolean, onOpen: () => void) {
  const open = useEffectEvent(onOpen);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey
        || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      const root = sidebar.current?.closest(".exported-shell");
      if (!root) return;
      // Do not take over an editor, settings form or menu that is already modal.
      const modal = document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
      if (modal && !modal.matches(".compact-drawer, .session-search-popover")) return;
      event.preventDefault();
      const input = root.querySelector<HTMLInputElement>(".session-search input");
      if (input) { input.focus(); input.select(); }
      else open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebar, enabled]);
}
