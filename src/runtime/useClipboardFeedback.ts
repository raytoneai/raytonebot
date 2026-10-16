import { useEffect, useRef, useState } from "react";

/**
 * One attempt at writing the clipboard, in the order that gives the user the best chance.
 *
 * The async Clipboard API is the only path that reports the truth, so it goes first. It refuses an
 * unfocused or hidden document and a permission the browser has denied (Chrome: "NotAllowedError:
 * Document is not focused"), and nothing in the page can force it. Asking for focus and trying once
 * more covers a window that had lost focus. The legacy command is refused in different cases, so it
 * is worth one attempt before the caller falls back to asking the user to copy by hand.
 */
export async function copyText(text: string): Promise<"clipboard" | "command" | "failed"> {
  const write = async () => { await navigator.clipboard.writeText(text); };
  try {
    await write();
    return "clipboard";
  } catch {
    try {
      window.focus();
      await write();
      return "clipboard";
    } catch { /* the legacy command is all that is left */ }
  }
  // Selecting the textarea moves focus into it; hand focus back so a keyboard user stays on the button.
  const focused = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  try {
    area.value = text;
    area.setAttribute("readonly", "");
    // Off-screen but still selectable; `display: none` and `hidden` are not.
    area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy") ? "command" : "failed";
  } catch {
    return "failed";
  } finally {
    area.remove();
    focused?.focus?.({ preventScroll: true });
  }
}

/** Select an element's text, so a refused copy leaves the user one keystroke from copying it. */
function selectContents(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Success is reported only after the browser accepts the actual text. `copy(source)` takes the
 * on-screen element showing that text; when every write is refused it is selected, which is what
 * lets the failure copy say "press ⌘C".
 */
export function useClipboardFeedback(text: string) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setStatus("idle");
    return () => { attempt.current++; clearTimeout(timer.current); };
  }, [text]);
  async function copy(source?: Element | null) {
    const current = ++attempt.current;
    clearTimeout(timer.current);
    const result: typeof status = await copyText(text) === "failed" ? "failed" : "copied";
    if (current !== attempt.current) return;
    if (result === "failed" && source) selectContents(source);
    setStatus(result);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  }
  return { status, copy };
}
