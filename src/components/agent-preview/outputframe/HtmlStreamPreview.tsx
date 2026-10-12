import { useEffect, useRef, useState } from "react";
import { FileCode2 } from "lucide-react";

import type { LiveHtmlWrite } from "../../../runtime/liveHtmlWrite";
import { streamingHtmlBody } from "../../../runtime/liveHtmlWrite";
import { useShellExtras } from "../../shell/ShellExtras";
import { htmlStreamDocument } from "./htmlPreview";
import type { OutputFrameCopy } from "./types";

const THROTTLE_MS = 150;

/**
 * The page an HTML write is producing, as it arrives. The frame loads once and its body is
 * replaced in place, so the page grows without reloading or flashing. Nothing in the page runs
 * (`htmlStreamDocument`) until the file is saved and opens as itself (`HtmlOutputPreview`).
 * A theme switch restyles the frame in place too.
 */
export function HtmlStreamPreview({ live, copy }: { live: LiveHtmlWrite; copy: OutputFrameCopy }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const { artifactThemeCss: themeCss = "" } = useShellExtras();
  const [srcDoc] = useState(() => htmlStreamDocument(themeCss, crypto.randomUUID().replace(/-/g, "")));
  const body = streamingHtmlBody(live.html);
  const sent = useRef({ body: "", at: 0 });

  useEffect(() => {
    if (loaded) frame.current?.contentWindow?.postMessage({ raytoneTheme: themeCss }, "*");
  }, [loaded, themeCss]);

  useEffect(() => {
    if (!loaded || sent.current.body === body) return;
    const post = () => {
      sent.current = { body, at: Date.now() };
      frame.current?.contentWindow?.postMessage({ raytoneStream: body }, "*");
    };
    const wait = THROTTLE_MS - (Date.now() - sent.current.at);
    if (wait <= 0) return post();
    const timer = setTimeout(post, wait);
    return () => clearTimeout(timer);
  }, [loaded, body]);

  return (
    <div className="opened-output-item" data-kind="file" data-render-kind="html" aria-busy="true">
      <div className="artifact-title">
        <FileCode2 size={16} />
        <span>{live.title}</span>
        <em role="status">{copy.liveHtmlPreview}</em>
        <code>html</code>
      </div>
      <iframe ref={frame} className="html-output-preview" title={live.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={() => setLoaded(true)} />
    </div>
  );
}
