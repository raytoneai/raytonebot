import type { BrowserInput } from "../pi/browser/browserProtocol";

/**
 * The live browser view's input mapping (ADR-040), kept out of the component so it can be tested.
 * Frames are drawn with `object-fit: contain`, so a click is mapped through the letterbox into
 * the page's CSS pixels; a click on the bars maps to nothing.
 */
export function framePoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number },
  frame: { width: number; height: number }): { x: number; y: number } | undefined {
  if (!frame.width || !frame.height || !box.width || !box.height) return undefined;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const shownWidth = frame.width * scale, shownHeight = frame.height * scale;
  const left = box.left + (box.width - shownWidth) / 2, top = box.top + (box.height - shownHeight) / 2;
  const x = (clientX - left) / scale, y = (clientY - top) / scale;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Keys sent as key presses; printable text arrives through the hidden field's input instead. */
const NAMED = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Shift", "Control", "Alt", "Meta"]);

export function keyInput(type: "down" | "up", event: { key: string; isComposing?: boolean }): BrowserInput | undefined {
  if (event.isComposing || !NAMED.has(event.key)) return undefined;
  return { kind: "key", type, key: event.key };
}

export function mouseButton(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

/** One in-flight request; collapse unsent motion/text so network RTT cannot build an input backlog. */
export function createBrowserInputQueue(send: (inputs: BrowserInput[], signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void) {
  let pending: BrowserInput[] = [];
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (active || timer || !pending.length) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 16);
  };
  const flush = async () => {
    const controller = new AbortController();
    active = controller;
    const batch = pending;
    pending = [];
    try { await send(batch, controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) { pending = []; onError(error); }
    } finally {
      if (active === controller) { active = undefined; schedule(); }
    }
  };
  const reset = () => {
    clearTimeout(timer); timer = undefined;
    pending = [];
    active?.abort(); active = undefined;
  };
  return {
    input(value: BrowserInput) {
      const last = pending.at(-1);
      if (value.kind === "mouse" && value.type === "move" && last?.kind === "mouse" && last.type === "move") pending[pending.length - 1] = value;
      else if (value.kind === "text" && last?.kind === "text" && last.text.length + value.text.length <= 2000) last.text += value.text;
      else if (value.kind === "mouse" && value.type === "wheel" && last?.kind === "mouse" && last.type === "wheel") {
        pending[pending.length - 1] = { ...value, deltaX: Math.max(-5000, Math.min(5000, (last.deltaX ?? 0) + (value.deltaX ?? 0))), deltaY: Math.max(-5000, Math.min(5000, (last.deltaY ?? 0) + (value.deltaY ?? 0))) };
      } else if (pending.length < 64) pending.push({ ...value });
      else { reset(); onError(new Error("Browser input is falling behind. Try again when the connection recovers.")); return; }
      schedule();
    },
    reset,
  };
}
