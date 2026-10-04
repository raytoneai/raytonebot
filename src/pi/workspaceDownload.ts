import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { mediaType } from "../runtime/mediaType.ts";

function byteRange(value: string | undefined, size: number): { start: number; end: number } | false | undefined {
  // ponytail: native media needs a single range; unsupported units/multipart use ordinary 200.
  if (!value?.startsWith("bytes=") || value.includes(",")) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const first = Number(match[1]), last = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return false;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] ? Math.min(last, size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : false;
}

/** Takes ownership of an already validated descriptor; never reopens the mutable pathname. */
export async function sendWorkspaceFile(req: IncomingMessage, res: ServerResponse, entry: { file: FileHandle; name: string; size: number }): Promise<void> {
  try {
    // Without a strong version validator an If-Range condition cannot be established.
    const range = req.method === "HEAD" || req.headers["if-range"] ? undefined : byteRange(req.headers.range, entry.size);
    const type = mediaType(entry.name);
    res.setHeader("content-type", type?.match(/^(audio|video)\//) ? type : "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(entry.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    res.setHeader("accept-ranges", "bytes");
    if (range === false) {
      res.writeHead(416, { "content-range": `bytes */${entry.size}`, "content-length": 0 });
      res.end();
      return;
    }
    res.statusCode = range ? 206 : 200;
    res.setHeader("content-length", range ? range.end - range.start + 1 : entry.size);
    if (range) res.setHeader("content-range", `bytes ${range.start}-${range.end}/${entry.size}`);
    if (req.method === "HEAD" || entry.size === 0) res.end();
    else await pipeline(entry.file.createReadStream({ ...range, autoClose: false }), res);
  } finally { await entry.file.close(); }
}
