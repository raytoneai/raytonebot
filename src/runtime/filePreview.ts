import { piFileDownloadUrl, type PiFileScope, type PiRuntimeState } from "../pi/piClient.ts";
export { mediaType } from "./mediaType.ts";

/** Resolve only explicit workspace paths; display titles are not file references. */
export function workspaceFileUrl(path: string, scope: PiFileScope, workspace?: PiRuntimeState["workspace"]): string | undefined {
  const roots = [[scope, scope === "shared" ? workspace?.shared : workspace?.agents[scope]], ["shared", workspace?.shared]] as const;
  const base = roots[0][1];
  if (base) {
    const parts: string[] = [];
    for (const part of (path.startsWith("/") ? path : `${base}/${path}`).split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    path = `/${parts.join("/")}`;
  }
  const match = roots.find(([, root]) => root && path.startsWith(`${root.replace(/\/$/, "")}/`));
  const relative = match ? path.slice(match[1]!.replace(/\/$/, "").length + 1) : path.startsWith("/") ? undefined : path.replace(/^\.\//, "");
  return relative ? piFileDownloadUrl(match?.[0] ?? scope, relative) : undefined;
}

/** Inline previews never fetch model-provided external URLs or execute SVG as a document. */
export function inlineMediaSource(source?: string): string | undefined {
  return source && /^(?:data:(?:image|audio|video)\/[a-z0-9.+-]+[;,]|blob:)/i.test(source) ? source : undefined;
}

// Text, images and PDF still use bounded whole-file previews; audio/video stream directly.
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

export async function readPreviewBlob(response: Response, type = ""): Promise<Blob> {
  if (!response.ok) throw new Error("unavailable");
  if (Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES) {
    await response.body?.cancel();
    throw new Error("too-large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("unavailable");
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PREVIEW_BYTES) throw new Error("too-large");
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
    const blob = new Blob(chunks, { type });
    if (type === "application/pdf" && !/^%PDF-\d\.\d/.test(await blob.slice(0, 8).text())) throw new Error("unavailable");
    return blob;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
