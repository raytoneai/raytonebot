import assert from "node:assert/strict";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiHttpHost } from "./piHost.ts";

test("workspace downloads support media seeking and metadata without bypassing file boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "rtb-ranges-"));
  const host = createPiHttpHost({ cwd: root, dataDir: join(root, ".private") });
  const server = createServer((req, res) => { void host.handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = (path = "clip.mp4") => `http://127.0.0.1:${(server.address() as { port: number }).port}/__agentcanvas/pi/files/download?${new URLSearchParams({ scope: "assistant", path })}`;
  const sample = "0123456789abcdef";
  try {
    await writeFile(join(root, "clip.mp4"), sample);
    for (const [range, start, end] of [["bytes=0-3", 0, 3], ["bytes=10-", 10, 15], ["bytes=-4", 12, 15], ["bytes=14-100", 14, 15], ["bytes=-100", 0, 15]] as const) {
      const response = await fetch(url(), { headers: { range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${sample.length}`);
      assert.equal(response.headers.get("content-length"), String(end - start + 1));
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(response.headers.get("content-type"), "video/mp4");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-disposition")!, /^attachment;/);
      assert.equal(await response.text(), sample.slice(start, end + 1));
    }
    for (const range of ["bytes=16-", "bytes=6-3", "bytes=-0", "bytes=-", "bytes=999999999999999999999-"]) {
      const response = await fetch(url(), { headers: { range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get("content-range"), `bytes */${sample.length}`);
      assert.equal(await response.text(), "");
    }
    // Unsupported/multipart ranges and unverifiable If-Range conditions fall back to a full response.
    const ordinaryRequests: Record<string, string>[] = [{ range: "items=0-1" }, { range: "bytes=0-1,4-5" }, { range: "bytes=0-1", "if-range": '"old-version"' }, {}];
    for (const headers of ordinaryRequests) {
      const response = await fetch(url(), { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-range"), null);
      assert.equal(await response.text(), sample);
    }
    const large = await open(join(root, "large.mp4"), "w");
    const size = 32 * 1024 * 1024;
    await large.truncate(size);
    await large.write(Buffer.from("TAIL"), 0, 4, size - 4);
    await large.close();
    const head = await fetch(url("large.mp4"), { method: "HEAD", headers: { range: "bytes=0-3" } });
    assert.equal(head.status, 200, "HEAD describes the complete resource and ignores Range");
    assert.equal(head.headers.get("content-length"), String(size));
    assert.equal(await head.text(), "");
    const tail = await fetch(url("large.mp4"), { headers: { range: "bytes=-4" } });
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), "TAIL", "seeking does not require buffering the whole file");
    const cancelled = await fetch(url("large.mp4"), { headers: { range: "bytes=0-" } });
    await cancelled.body!.cancel();
    assert.equal(await (await fetch(url())).text(), sample, "a cancelled transfer leaves the host usable");
    await writeFile(join(root, "empty.txt"), "");
    assert.equal(await (await fetch(url("empty.txt"))).text(), "");
    assert.equal((await fetch(url("empty.txt"), { headers: { range: "bytes=0-" } })).status, 416);
    await writeFile(join(root, "page.html"), "<script>bad()</script>");
    const html = await fetch(url("page.html"));
    assert.equal(html.headers.get("content-type"), "application/octet-stream");
    assert.match(html.headers.get("content-disposition")!, /^attachment;/);
    await html.body!.cancel();
    await symlink(join(root, "clip.mp4"), join(root, "linked.mp4"));
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["../outside", ".private/env", "linked.mp4"]) {
        assert.equal((await fetch(url(path), { method, headers: { range: "bytes=0-3" } })).status, 403);
      }
      assert.equal((await fetch(url(), { method, headers: { origin: "https://other.example", range: "bytes=0-3" } })).status, 403);
    }
  } finally {
    host.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
