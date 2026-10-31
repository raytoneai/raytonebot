import { useLayoutEffect, useState } from "react";

/** Reveal the current item by moving only the rail, without changing focus or page scroll. */
export function revealCurrentSettingsSection(rail: HTMLElement) {
  const current = rail.querySelector<HTMLElement>('[aria-current="page"]');
  if (!current || rail.clientWidth === 0 || rail.scrollWidth <= rail.clientWidth) return;
  const bounds = rail.getBoundingClientRect();
  const item = current.getBoundingClientRect();
  // Dialog enter/exit scales affect rectangles, but not scroll offsets.
  const scale = rail.offsetWidth > 0 ? bounds.width / rail.offsetWidth : 1;
  if (scale <= 0) return;
  const left = bounds.left + rail.clientLeft * scale;
  const right = left + rail.clientWidth * scale;
  const delta = item.left < left ? item.left - left : item.right > right ? item.right - right : 0;
  // Immediate scrolling also honors reduced-motion without a separate animation path.
  if (delta) rail.scrollLeft += delta / scale;
}

export function useSettingsNavigation(open: boolean, section: string, locale: string) {
  // A callback ref observes Radix's delayed portal mount as well as reopening.
  const [rail, setRail] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open || !rail) return;
    const reveal = () => revealCurrentSettingsSection(rail);
    reveal();
    // No scroll listener: manual horizontal browsing stays where the user leaves it.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(reveal);
      observer.observe(rail);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [open, rail, section, locale]);
  return setRail;
}
