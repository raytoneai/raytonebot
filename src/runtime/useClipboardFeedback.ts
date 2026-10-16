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
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // Off-screen but still selectable; `display: none` and `hidden` are not.
    area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied ? "command" : "failed";
  } catch {
    return "failed";
  }
}

/** Success is reported only after the browser accepts the actual text. */
export function useClipboardFeedback(text: string) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setStatus("idle");
    return () => { attempt.current++; clearTimeout(timer.current); };
  }, [text]);
  async function copy() {
    const current = ++attempt.current;
    clearTimeout(timer.current);
    const result: typeof status = await copyText(text) === "failed" ? "failed" : "copied";
    if (current !== attempt.current) return;
    setStatus(result);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  }
  return { status, copy };
}
