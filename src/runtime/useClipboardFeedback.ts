import { useEffect, useRef, useState } from "react";

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
    let result: typeof status = "copied";
    try { await navigator.clipboard.writeText(text); }
    catch { result = "failed"; }
    if (current !== attempt.current) return;
    setStatus(result);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
  }
  return { status, copy };
}
