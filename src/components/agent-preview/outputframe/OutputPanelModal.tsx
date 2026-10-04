import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { useCopy } from "../../../i18n/LocaleContext";
import type { OutputPanelItem } from "./panelItem";
import { outputItemModalRenderer } from "./renderKind";
import { outputTitle } from "./labels";
import { OpenedOutputItem, OutputTabs } from "./OutputTabs";

export function OutputPanelModal({
  items,
  activeId,
  onSelectItem,
  onCloseItem,
  onClose,
}: {
  items: readonly OutputPanelItem[];
  activeId?: string;
  onSelectItem?: (id: string) => void;
  onCloseItem?: (id: string) => void;
  onClose: () => void;
}) {
  const copy = useCopy();
  const c = copy.workspace.outputFrame;
  const activeItem = items.find((item) => item.id === activeId) ?? items[items.length - 1];
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], iframe, audio[controls], video[controls], [tabindex="0"]') ?? []);
    controls()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = controls();
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => { window.removeEventListener("keydown", handleKeyDown); if (previous?.isConnected) previous.focus(); };
  }, []);

  if (!activeItem) {
    return null;
  }

  return (
    <>
      <div className="artifact-expand-backdrop" aria-hidden="true" onClick={onClose} />
      <section
        ref={panelRef}
        className="utility-card artifact-frame output-modal-frame"
        data-expanded="true"
        data-output-modal="true"
        data-output-source="artifact"
        role="dialog"
        aria-modal="true"
        aria-label={outputTitle("artifact", outputItemModalRenderer(activeItem), c)}
      >
        <header className="utility-header">
          <div>
            <h3>{outputTitle("artifact", outputItemModalRenderer(activeItem), c)}</h3>
          </div>
          <div className="utility-header-actions">
            <button
              className="rail-icon-btn"
              type="button"
              aria-label="Close output"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="artifact-content opened-output">
          {items.length > 1 ? (
            <OutputTabs
              items={items}
              activeId={activeItem.id}
              onSelectOpenItem={onSelectItem}
              onCloseOpenItem={onCloseItem}
            />
          ) : null}
          <OpenedOutputItem item={activeItem} copy={c} />
        </div>
      </section>
    </>
  );
}
