import { animate } from "motion";

import type { AvatarKind } from "./raytoneAvatars";

/**
 * Blink, gaze and state motion for a `avatarSVG()` element. Ported from the avatar study in
 * output/raytone-avatars/animated/motion.js, with the behaviour of agent-robot-avatar
 * (CX-ArtLab): eyes that wander and glance between fixations, a head that lags the eyes, and a
 * short gesture whenever the agent's activity changes. `interactive: false` skips every pointer
 * listener so a small avatar costs a couple of timers, not a window-wide pointermove handler.
 *
 * Layers, outermost first: `.drag-group` (drag), `.follow-group` (head turn from gaze or
 * pointer), `.action-group` (the state's pose, CSS), `.gesture-group` (one-shot gestures,
 * WAAPI); eyes: `.gaze` (glances, pointer) > `.thinking-gaze` (state loops, CSS) > `.blink`.
 */
export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "reading"
  | "editing"
  | "working"
  | "writing"
  | "asking"
  | "success"
  | "error"
  | "sleep";

export type AvatarMotion = {
  setState(next: AvatarState): void;
  destroy(): void;
};

/** States in which a turn is still in progress or waiting on the user. */
const BUSY = new Set<AvatarState>(["thinking", "reading", "editing", "working", "writing", "asking"]);
export const avatarBusy = (state: AvatarState) => BUSY.has(state);

const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
const between = (min: number, max: number) => min + Math.random() * (max - min);
const spring = { type: "spring", duration: 0.5, bounce: 0.2 } as const;
const settle = "cubic-bezier(.2,.8,.2,1)";
/** Pose changes between states: slow in and out, the same 420ms the CSS loops wait for. */
const poseEase = "cubic-bezier(.45,0,.25,1)";
const POSE_MS = 420;

/** A short gesture as the activity changes; the pose itself is CSS on `.action-group`. */
function gestureFor(previous: AvatarState, next: AvatarState): { frames: Keyframe[]; duration: number } | undefined {
  if (avatarBusy(next) && next !== "asking" && !avatarBusy(previous)) {
    // Sent: a small nod, "got it".
    return { duration: 380, frames: [
      { transform: "translateY(0px)" },
      { transform: "translateY(18.9px) scale(1.01, 0.98)", offset: 0.45 },
      { transform: "translateY(0px)" },
    ] };
  }
  if (next === "asking") {
    return { duration: 340, frames: [
      { transform: "scale(1)" },
      { transform: "translateY(-12.2px) scale(1.08)", offset: 0.4 },
      { transform: "scale(1)" },
    ] };
  }
  if (next === "success") {
    return { duration: 640, frames: [
      { transform: "translateY(0px) scale(1, 1)" },
      { transform: "translateY(8.1px) scale(1.05, 0.93)", offset: 0.14 },
      { transform: "translateY(-32px) scale(0.97, 1.04)", offset: 0.4 },
      { transform: "translateY(0px) scale(1.04, 0.96)", offset: 0.66 },
      { transform: "translateY(-8.1px) scale(1, 1)", offset: 0.82 },
      { transform: "translateY(0px) scale(1, 1)" },
    ] };
  }
  if (next === "error") {
    return { duration: 560, frames: [
      { transform: "translateX(0px) rotate(0deg)" },
      { transform: "translateX(-18.9px) rotate(-4.1deg)", offset: 0.18 },
      { transform: "translateX(16.2px) rotate(4.1deg)", offset: 0.4 },
      { transform: "translateX(-10.8px) rotate(-2deg)", offset: 0.62 },
      { transform: "translateX(5.4px) rotate(0deg)", offset: 0.82 },
      { transform: "translateX(0px) rotate(0deg)" },
    ] };
  }
  if (next === "listening" && previous === "idle") {
    return { duration: 300, frames: [
      { transform: "translateY(0px)" },
      { transform: "translateY(-10.8px)", offset: 0.45 },
      { transform: "translateY(0px)" },
    ] };
  }
  return undefined;
}

/**
 * Each character's own idle habit, for a calm avatar (in the group but not speaking): a head tilt,
 * an upward ponder, a small hop, a slow nod. Played rarely, so a transcript of faces looks present
 * without a row of identical loops.
 */
const HABITS: Record<AvatarKind, { frames: Keyframe[]; duration: number; gaze?: [number, number, number] }> = {
  woman: { duration: 900, frames: [
    { transform: "rotate(0deg)" }, { transform: "rotate(-6.8deg)", offset: 0.35 }, { transform: "rotate(2.7deg)", offset: 0.7 }, { transform: "rotate(0deg)" },
  ] },
  man: { duration: 1600, gaze: [-15, -8, -3], frames: [
    { transform: "translateY(0px)" }, { transform: "translateY(-4.1px)", offset: 0.3 }, { transform: "translateY(-4.1px)", offset: 0.75 }, { transform: "translateY(0px)" },
  ] },
  boy: { duration: 520, frames: [
    { transform: "translateY(0px) scale(1, 1)" }, { transform: "translateY(4.1px) scale(1.03, 0.97)", offset: 0.2 },
    { transform: "translateY(-12.2px) scale(0.99, 1.02)", offset: 0.5 }, { transform: "translateY(0px) scale(1, 1)" },
  ] },
};

export function mountAvatarMotion(root: HTMLElement, options: { interactive: boolean; calm?: boolean; kind?: AvatarKind }): AvatarMotion {
  const abort = new AbortController();
  const listen = { signal: abort.signal };
  const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const fineQuery = matchMedia("(hover: hover) and (pointer: fine)");
  const head = root.querySelector<SVGGElement>(".drag-group");
  const follow = root.querySelector<SVGGElement>(".follow-group");
  const gesture = root.querySelector<SVGGElement>(".gesture-group");
  /** Layers whose pose or loop changes with the state; see `settlePose`. */
  const posed = [...root.querySelectorAll<SVGGElement>(".action-group, .thinking-gaze")];
  const gaze = root.querySelector<SVGGElement>(".gaze");
  const lids = [...root.querySelectorAll<SVGGElement>(".blink")];
  let state: AvatarState = "idle";
  let reduced = reduceQuery.matches;
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  let glanceTimer: ReturnType<typeof setTimeout> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let habitTimer: ReturnType<typeof setTimeout> | undefined;
  /** A calm avatar blinks and glances about half as often as the one speaking. */
  const pace = options.calm ? 2.2 : 1;
  let pointerAt = 0;
  let drag: { id: number; x: number; y: number; width: number; moved: boolean } | null = null;
  let release: { stop(): void } | undefined;
  let destroyed = false;

  const still = () => destroyed || reduced || document.hidden;
  const stopTimers = () => {
    clearTimeout(blinkTimer);
    clearTimeout(glanceTimer);
    clearTimeout(resetTimer);
    clearTimeout(habitTimer);
  };
  const look = (x: number, y: number, turn = x / 2.6) => {
    if (gaze) gaze.style.transform = `translate(${x}px, ${y}px)`;
    if (follow) follow.style.transform = `translate(${x / 2.4}px, ${y / 3}px) rotate(${turn}deg)`;
  };
  const centerGaze = () => look(0, 0, 0);
  const blink = () => {
    if (state === "success" || state === "sleep") return;
    for (const lid of lids) {
      lid.animate(
        [{ transform: "scaleY(1)" }, { transform: "scaleY(.08)" }, { transform: "scaleY(1)" }],
        { duration: 150 + Math.random() * 60, easing: "cubic-bezier(.45,0,.25,1)" },
      );
    }
  };
  const queueBlink = () => {
    clearTimeout(blinkTimer);
    if (still() || state === "sleep") return;
    blinkTimer = setTimeout(() => {
      blink();
      // Now and then a double blink, the way a person resets their eyes.
      if (Math.random() < 0.18) setTimeout(() => { if (!still()) blink(); }, 260);
      queueBlink();
    }, (2200 + Math.random() * 2800) * pace);
  };
  /**
   * Idle eyes do not stare: they hold a point, then jump to the next one, and the head
   * follows a little later (its transition is slower than the eyes'). Listening keeps the
   * glances low and short, toward the composer the user is typing in.
   */
  const queueGlance = () => {
    clearTimeout(glanceTimer);
    if (still() || (state !== "idle" && state !== "listening")) return;
    const listening = state === "listening";
    glanceTimer = setTimeout(() => {
      const pointerDriven = options.interactive && performance.now() - pointerAt < 1400;
      if (!drag && !pointerDriven && (state === "idle" || state === "listening")) {
        if (listening) look(between(-17, 17), between(6, 11), between(-4.5, 4.5));
        else if (Math.random() < 0.3) centerGaze();
        else {
          const x = between(-22, 22), y = between(-9, 8);
          // Occasionally a curious head tilt that the eyes do not explain.
          look(x, y, Math.random() < 0.12 ? (x < 0 ? -11 : 11) : x / 2.6);
        }
        if (Math.random() < 0.22) setTimeout(() => { if (!still()) blink(); }, 40);
      }
      queueGlance();
    }, (listening ? between(500, 1300) : between(1100, 3200)) * pace);
  };
  const queueHabit = () => {
    clearTimeout(habitTimer);
    const habit = options.kind && HABITS[options.kind];
    if (!options.calm || !habit || still() || state !== "idle") return;
    habitTimer = setTimeout(() => {
      if (!still() && state === "idle" && gesture?.animate) {
        for (const running of gesture.getAnimations()) running.cancel();
        gesture.animate(habit.frames, { duration: habit.duration, easing: settle });
        if (habit.gaze) {
          look(...habit.gaze);
          setTimeout(() => { if (state === "idle") centerGaze(); }, habit.duration * 0.8);
        }
      }
      queueHabit();
    }, between(9000, 17000));
  };
  /**
   * A state change would cut from wherever the old pose or loop was to the new state's first
   * frame. Instead, read each layer's on-screen transform before the switch and ease from it to
   * the new pose; the new state's CSS loop waits the same POSE_MS and starts from that pose.
   */
  const settlePose = (apply: () => void) => {
    if (still() || !posed[0]?.animate) return apply();
    const from = posed.map((layer) => getComputedStyle(layer).transform);
    for (const layer of posed) for (const running of layer.getAnimations()) if (!("animationName" in running)) running.cancel();
    apply();
    posed.forEach((layer, index) => {
      const to = getComputedStyle(layer).transform;
      if (from[index] !== to) layer.animate([{ transform: from[index] }, { transform: to }], { duration: POSE_MS, easing: poseEase });
    });
  };
  const playGesture = (previous: AvatarState, next: AvatarState) => {
    if (!gesture || still() || !gesture.animate) return;
    const plan = gestureFor(previous, next);
    if (!plan) return;
    for (const running of gesture.getAnimations()) running.cancel();
    gesture.animate(plan.frames, { duration: plan.duration, easing: settle });
  };
  const endDrag = (cancelled = false) => {
    if (!drag || !head) return;
    const previous = drag;
    drag = null;
    root.dataset.dragging = "false";
    if (root.hasPointerCapture(previous.id)) root.releasePointerCapture(previous.id);
    release?.stop();
    if (still()) head.style.transform = "none";
    else release = animate(head, { transform: "translate(0px, 0px) rotate(0deg) scale(1, 1)" }, spring);
    if (!cancelled && !previous.moved) setState("success");
  };
  const setState = (next: AvatarState) => {
    if (destroyed) return;
    const previous = state;
    stopTimers();
    endDrag(true);
    state = next;
    settlePose(() => { root.dataset.state = next; });
    if (next === "listening") look(0, 8, 0);
    else centerGaze();
    if (previous !== next) playGesture(previous, next);
    queueBlink();
    queueGlance();
    queueHabit();
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
    queueGlance();
    queueHabit();
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
      pointerAt = performance.now();
      const bounds = root.getBoundingClientRect();
      // Falls off with distance: a pointer across the window gets a glance, not a stare.
      const reach = Math.max(bounds.width * 6, 480);
      const dx = event.clientX - bounds.left - bounds.width / 2;
      const dy = event.clientY - bounds.top - bounds.height / 2;
      look(clamp(dx / reach, 1) * 22, clamp(dy / reach, 1) * 10);
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
    document.documentElement.addEventListener("pointerleave", () => {
      pointerAt = 0;
      centerGaze();
    }, listen);
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
    queueGlance();
    queueHabit();
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
