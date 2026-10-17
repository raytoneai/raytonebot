// Local synthetic site + the actual BrowserView. Drive the view with CUA; no model, account or production data.
// node scripts/check-browser-latency.mjs [--slow]
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import { sandboxLibsPlugin } from "./sandbox-libs-plugin.mjs";
import { createBrowserService } from "../src/pi/browser/browserService.ts";
import { createPiHttpHost } from "../src/pi/piHost.ts";
const slow = process.argv.includes("--slow"), delay = slow ? 150 : 0;
const root = mkdtempSync(join(tmpdir(), "rtb-browser-latency-"));
let inputCount = 0;
const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end('<title>Synthetic input</title><label>Echo<input autofocus style="font-size:40px" oninput="document.querySelector(\'output\').textContent=this.value"></label><output style="display:block;font-size:40px"></output>');
});
await new Promise(r => site.listen(0, "127.0.0.1", r));
const port = site.address().port;
const browser = createBrowserService({ dataDir: root, allowAddress: ip => ip === "127.0.0.1", allowPort: p => p === port });
const tools = browser.toolsFor({ conversationId: "synthetic", agent: "assistant", ask: async () => null, saveDownload: async () => "" });
await tools.run("browser_open", { url: `http://127.0.0.1:${port}/` });
await browser.takeover();
const host = createPiHttpHost({ cwd: root, dataDir: join(root, "data"), sandboxed: false, browser, routineClock: false });
const vite = await createViteServer({ configFile: false, root: process.cwd(), cacheDir: join(root, "vite-cache"), optimizeDeps: { entries: [], include: ["react", "react-dom/client"] }, plugins: [react(), sandboxLibsPlugin(), { resolveId(id) { if (id === "virtual:browser-latency-view") return "\0browser-latency-view"; }, load(id) { if (id === "\0browser-latency-view") return `import React from "react";import{createRoot}from"react-dom/client";import{BrowserView}from"/src/components/agent-preview/outputframe/BrowserView.tsx";import{workspaceCopy}from"/src/i18n/copy/workspace.ts";import"/src/styles/app.css";createRoot(document.getElementById("root")).render(React.createElement(BrowserView,{copy:workspaceCopy.zh.outputFrame}));`; }, name: "browser-latency-check", configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/latency")) {
      res.setHeader("content-type", "text/html");
      res.end(await server.transformIndexHtml("/latency", `<html><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module" src="/@id/virtual:browser-latency-view"></script></body></html>`)); return;
    }
    if (req.url?.startsWith('/__agentcanvas/pi/')) {
      if (req.url.endsWith('/browser/input')) inputCount++;
      if (delay) {
        await new Promise(r => setTimeout(r, delay));
        const write = res.write.bind(res);
        const end = res.end.bind(res);
        // Symmetric artificial transport delay, including SSE frames; preserve stream order.
        const writes = [];
        res.write = (...args) => { writes.push(new Promise(r => setTimeout(r, delay)).then(() => { if (!res.destroyed) write(...args); })); return true; };
        res.end = (...args) => { void Promise.all(writes).then(() => new Promise(r => setTimeout(r, delay))).then(() => { if (!res.destroyed) end(...args); }); return res; };
      }
      try { await host.handle(req, res); } catch (error) { next(error); } return;
    }
    next();
  });
} }], resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: slow ? 5195 : 5194, strictPort: true } });
await vite.listen();
console.log(JSON.stringify({ url: `http://127.0.0.1:${slow ? 5195 : 5194}/latency?devtools=1`, delayEachDirectionMs: delay, pid: process.pid }));
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
async function close() {
  console.log(JSON.stringify({ inputBatchesReceived: inputCount, note: "Read p50/p95 from BrowserView data-latency attributes; no input content is logged." }));
  await browser.stop(); host.dispose(); await vite.close(); site.closeAllConnections(); site.close(); rmSync(root, { recursive: true, force: true }); process.exit(0);
}
