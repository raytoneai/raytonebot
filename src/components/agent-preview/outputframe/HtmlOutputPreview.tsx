import { useEffect, useRef } from "react";

import { useShellExtras } from "../../shell/ShellExtras";
import { parseArtifactRequest } from "../../../runtime/artifactBridge";
import { htmlPreviewDocument } from "./htmlPreview";
import { artifactThemeCss } from "./artifactTheme";

/**
 * The sandboxed HTML page, plus the one channel it has back to the page: a follow-up or an
 * https link, each only right after the user clicked inside it. Nothing is sent on load, on a
 * timer or while dragging a slider, because none of those carry a user activation.
 */
export function HtmlOutputPreview({ title, body }: { title: string; body: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { onArtifactPrompt } = useShellExtras();
  const sendPrompt = useRef(onArtifactPrompt);
  sendPrompt.current = onArtifactPrompt;

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const request = parseArtifactRequest(event.data);
      if (!request) return;
      const reply = (answer: { ok: true } | { error: string }) => event.ports[0]?.postMessage(answer);
      if ("error" in request) return reply(request);
      // A click inside the frame both focuses it and activates this page; the frame can forge
      // neither. Activation alone is not enough: the click that opened the file still counts
      // for a few seconds, long enough for a page to send on load.
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
      if (document.activeElement !== frame.current || activation?.isActive === false) {
        return reply({ error: "only a click can send" });
      }
      if (request.kind === "link") {
        window.open(request.url, "_blank", "noopener,noreferrer");
        return reply({ ok: true });
      }
      if (!sendPrompt.current) return reply({ error: "this conversation cannot take follow-ups" });
      sendPrompt.current(request.text);
      reply({ ok: true });
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  // Read at render: a theme switch re-renders the shell, and srcDoc only reloads if this changes.
  const styles = getComputedStyle(document.documentElement);
  const appearance = document.querySelector("[data-appearance]")?.getAttribute("data-appearance") === "dark" ? "dark" : "light";
  const themeCss = artifactThemeCss((name) => styles.getPropertyValue(name), appearance);
  return <iframe ref={frame} className="html-output-preview" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(body, themeCss)} />;
}
