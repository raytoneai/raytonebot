import { useEffect, useState, type RefObject } from "react";

const PREVIEW_RESPONSIVE_WIDTHS = {
  hideRightPanel: 860,
  hideLeftSidebar: 660,
} as const;

export function useAutoHiddenRails(frameRef: RefObject<HTMLDivElement | null>) {
  const [autoHiddenRails, setAutoHiddenRails] = useState({ left: false, right: false });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateAutoHiddenRails = (width: number) => {
      const next = {
        right: width < PREVIEW_RESPONSIVE_WIDTHS.hideRightPanel,
        left: width < PREVIEW_RESPONSIVE_WIDTHS.hideLeftSidebar,
      };
      setAutoHiddenRails((current) =>
        current.left === next.left && current.right === next.right ? current : next,
      );
    };

    updateAutoHiddenRails(frame.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      updateAutoHiddenRails(entries[0]?.contentRect.width ?? frame.getBoundingClientRect().width);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);

  return autoHiddenRails;
}
