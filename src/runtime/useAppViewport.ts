import { useEffect } from "react";

/** Keep the shell and body portals inside the area above the software keyboard. */
export function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    const properties = ["--app-viewport-height", "--app-viewport-top"] as const;
    const previous = properties.map(property => style.getPropertyValue(property));
    let frame = 0;
    const update = () => {
      frame = 0;
      // Pinch zoom keeps native panning, not application shrink/reflow.
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      style.setProperty(properties[0], `${viewport.height}px`);
      style.setProperty(properties[1], `${viewport.offsetTop}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      properties.forEach((property, index) => previous[index]
        ? style.setProperty(property, previous[index]) : style.removeProperty(property));
    };
  }, []);
}
