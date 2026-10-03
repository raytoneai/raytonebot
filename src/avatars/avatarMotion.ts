import { animate } from "motion";

/**
 * Blink, gaze and state motion for a `avatarSVG()` element. Ported from the avatar study in
 * output/raytone-avatars/animated/motion.js; `interactive: false` skips every pointer
 * listener so the many small avatars in a transcript cost one blink timer each, not a
 * window-wide pointermove handler each.
 */
export type AvatarState = "idle" | "waiting" | "success" | "warning" | "sleep";

export type AvatarMotion = {
  setState(next: AvatarState): void;
  destroy(): void;
};

const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
const spring = { type: "spring", duration: 0.5, bounce: 0.2 } as const;

export function mountAvatarMotion(root: HTMLElement, options: { interactive: boolean }): AvatarMotion {
  const abort = new AbortController();
  const listen = { signal: abort.signal };
  const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const fineQuery = matchMedia("(hover: hover) and (pointer: fine)");
  const head = root.querySelector<SVGGElement>(".drag-group");
  const follow = root.querySelector<SVGGElement>(".follow-group");
  const gaze = root.querySelector<SVGGElement>(".gaze");
  const lids = [...root.querySelectorAll<SVGGElement>(".blink")];
  let state: AvatarState = "idle";
  let reduced = reduceQuery.matches;
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let drag: { id: number; x: number; y: number; width: number; moved: boolean } | null = null;
  let release: { stop(): void } | undefined;
  let destroyed = false;

  const stopTimers = () => {
    clearTimeout(blinkTimer);
    clearTimeout(resetTimer);
  };
  const centerGaze = () => {
    if (gaze) gaze.style.transform = "translate(0px, 0px)";
    if (follow) follow.style.transform = "rotate(0deg)";
  };
  const queueBlink = () => {
    clearTimeout(blinkTimer);
    if (destroyed || reduced || document.hidden || state === "sleep") return;
    blinkTimer = setTimeout(() => {
      if (state !== "success") {
        for (const lid of lids) {
          lid.animate(
            [{ transform: "scaleY(1)" }, { transform: "scaleY(.08)" }, { transform: "scaleY(1)" }],
            { duration: 180, easing: "cubic-bezier(.45,0,.25,1)" },
          );
        }
      }
      queueBlink();
    }, 2800 + Math.random() * 2600);
  };
  const endDrag = (cancelled = false) => {
    if (!drag || !head) return;
    const previous = drag;
    drag = null;
    root.dataset.dragging = "false";
    if (root.hasPointerCapture(previous.id)) root.releasePointerCapture(previous.id);
    release?.stop();
    if (reduced || document.hidden || destroyed) head.style.transform = "none";
    else release = animate(head, { transform: "translate(0px, 0px) rotate(0deg) scale(1, 1)" }, spring);
    if (!cancelled && !previous.moved) setState("success");
  };
  const setState = (next: AvatarState) => {
    if (destroyed) return;
    stopTimers();
    endDrag(true);
    state = next;
    root.dataset.state = next;
    centerGaze();
    queueBlink();
    if (next === "success") resetTimer = setTimeout(() => setState("idle"), 1400);
  };
  const syncReduced = () => {
    reduced = reduceQuery.matches;
    root.dataset.reduced = String(reduced);
    if (reduced) {
      endDrag(true);
      release?.stop();
      if (head) head.style.transform = "none";
      for (const running of root.getAnimations({ subtree: true })) running.cancel();
      centerGaze();
    }
    queueBlink();
  };

  if (options.interactive && head) {
    const move = (event: PointerEvent) => {
      if (reduced || document.hidden) return;
      if (drag) {
        if (event.pointerId !== drag.id) return;
        const dx = clamp((event.clientX - drag.x) * 400 / drag.width, 30);
        const dy = clamp((event.clientY - drag.y) * 400 / drag.width, 22);
        drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4;
        head.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 5}deg) scale(${1 + Math.abs(dx) / 500}, ${1 - Math.abs(dx) / 800})`;
        return;
      }
      if (!fineQuery.matches || event.pointerType === "touch" || state !== "idle" || !gaze || !follow) return;
      const bounds = root.getBoundingClientRect();
      const x = clamp((event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2), 1);
      const y = clamp((event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2), 1);
      gaze.style.transform = `translate(${x * 7}px, ${y * 5}px)`;
      follow.style.transform = `rotate(${x * 3}deg)`;
    };
    root.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary || reduced) return;
      setState("idle");
      release?.stop();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width: root.getBoundingClientRect().width, moved: false };
      root.dataset.dragging = "true";
      root.setPointerCapture(event.pointerId);
      head.style.transform = "translate(0px, 0px) rotate(0deg) scale(1.025, .97)";
    }, listen);
    window.addEventListener("pointermove", move, { ...listen, passive: true });
    root.addEventListener("pointerup", (event) => {
      if (drag?.id === event.pointerId) endDrag();
    }, listen);
    root.addEventListener("pointercancel", () => endDrag(true), listen);
    root.addEventListener("lostpointercapture", () => endDrag(true), listen);
    document.documentElement.addEventListener("pointerleave", centerGaze, listen);
    window.addEventListener("blur", () => {
      endDrag(true);
      centerGaze();
    }, listen);
    fineQuery.addEventListener("change", centerGaze, listen);
  }
  document.addEventListener("visibilitychange", () => {
    root.dataset.hidden = String(document.hidden);
    if (document.hidden) {
      endDrag(true);
      centerGaze();
    }
    queueBlink();
  }, listen);
  reduceQuery.addEventListener("change", syncReduced, listen);
  root.dataset.hidden = String(document.hidden);
  syncReduced();
  setState("idle");

  return {
    setState,
    destroy() {
      destroyed = true;
      stopTimers();
      endDrag(true);
      abort.abort();
      release?.stop();
      for (const running of root.getAnimations({ subtree: true })) running.cancel();
    },
  };
}
