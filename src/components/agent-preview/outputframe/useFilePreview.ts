import { useEffect, useMemo, useState } from "react";
import { inlineMediaSource, mediaType, readPreviewBlob } from "../../../runtime/filePreview";
import { PI_API_PREFIX } from "../../../pi/piClient";
import type { OutputPanelItem } from "./panelItem";

/** The opened preview owns its fetch and Blob lifetime, never the persisted conversation. */
export function useFilePreview(item: OutputPanelItem, downloadUrl?: string) {
  const [attempt, setAttempt] = useState(0);
  const key = useMemo(() => ({}), [item.id, item.body, item.imageSrc, item.mediaSrc, item.title, item.language, item.kind, downloadUrl, attempt]);
  const [result, setResult] = useState<{ key: object; body?: string; mediaSrc?: string; contentUrl?: string; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const run = async () => {
      const type = mediaType(item.title, item.language);
      let body = item.body;
      // PDF documents come from the authenticated workspace, never an unvalidated artifact URL.
      let source = type === "application/pdf" ? undefined : inlineMediaSource(item.mediaSrc) ?? inlineMediaSource(item.imageSrc) ?? inlineMediaSource(body);
      let blob: Blob | undefined;
      if (downloadUrl && item.kind === "file" && !source) {
        if (!downloadUrl.startsWith(`${PI_API_PREFIX}/files/download?`)) throw new Error("unavailable");
        if (type?.match(/^(audio|video)\//)) source = `${downloadUrl}&preview=${attempt}`;
        else {
          blob = await readPreviewBlob(await fetch(downloadUrl, { redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }), type);
          if (!type) {
            body = await blob.text();
            if (body.includes("\0")) throw new Error("unavailable");
          }
        }
      } else if (type === "image/svg+xml" && body && /<svg[\s>]/i.test(body)) {
        blob = new Blob([body], { type });
      } else if (!type && body !== undefined) {
        blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      }
      if (controller.signal.aborted) return;
      if (blob) {
        objectUrl = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
        if (type) source = objectUrl;
      }
      setResult({ key, body, mediaSrc: source, contentUrl: objectUrl ?? source });
    };
    void run().catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "unavailable" });
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [key]);
  const current = result?.key === key ? result : undefined;
  return {
    key, body: current?.body, mediaSrc: current?.mediaSrc, contentUrl: current?.contentUrl, error: current?.error,
    loading: result?.key !== key,
    retry: () => setAttempt((value) => value + 1),
  };
}
