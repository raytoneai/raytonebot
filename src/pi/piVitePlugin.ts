import { spawn } from "node:child_process";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

import { PI_API_PREFIX } from "./piClient.ts";
import { createPiHttpHost } from "./piHost.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";
import { sameOriginRequestAllowed } from "./requestOrigin.ts";

export { sameOriginRequestAllowed } from "./requestOrigin.ts";

/** Mount Pi into both `vite dev` and `vite preview`; the React bundle never imports the SDK. */
export function piRuntimePlugin(options: { cwd?: string; /** Trusted host fixture factory; never exposed over HTTP. */ createHost?(): ReturnType<typeof createPiHttpHost>; /** Host-only user channel, also used by isolated browser tests. */ openEntry?(url: string): void | Promise<void> } = {}): Plugin {
  // RAYTONEBOT_WORKSPACE separates the agent's working directory from the app's own code.
  // RAYTONEBOT_WORKSPACE_ROOT gives each role its own directory plus a shared one.
  const appRoot = process.cwd();
  const layout = resolveWorkspaceLayout({
    fallbackCwd: options.cwd ?? (process.env.RAYTONEBOT_WORKSPACE?.trim() || appRoot),
    root: process.env.RAYTONEBOT_WORKSPACE_ROOT,
  });
  let host: ReturnType<typeof createPiHttpHost> | undefined;
  const getHost = () => {
    if (!host) {
      ensureWorkspaceLayout(layout);
      host = options.createHost?.() ?? createPiHttpHost({ cwd: layout.agents.assistant, appRoot, layout });
    }
    return host;
  };

  const mount = (middlewares: { use(handler: (req: any, res: any, next: () => void) => void): void }) => {
    middlewares.use((req, res, next) => {
      if (!req.url?.startsWith(PI_API_PREFIX)) {
        next();
        return;
      }
      if (!sameOriginRequestAllowed(req)) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Cross-origin Pi requests are not allowed.", code: "control_origin_invalid" }));
        return;
      }
      void getHost().handle(req, res).catch(next);
    });
  };

  const userEntry = (server: ViteDevServer | PreviewServer) => {
    // Cloud authentication belongs to accessGate. Non-interactive starts never print secrets.
    if (process.env.RAYTONEBOT_PUBLIC_ORIGIN || (!options.openEntry && !process.stdin.isTTY)) return;
    const open = () => {
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") return;
      const origin = `http://127.0.0.1:${address.port}`;
      const url = `${origin}/#control-plane=${getHost().controlPlaneAuth.issueEntry(origin)}`;
      if (options.openEntry) { void Promise.resolve(options.openEntry(url)).catch(() => server.config.logger.warn("Could not open the authorization entry. Press a + Enter to retry.")); return; }
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
      const env = Object.fromEntries(["PATH", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      const child = spawn(command, args, { stdio: "ignore", detached: true, env });
      child.on("error", () => server.config.logger.warn("Could not open the authorization entry. Press a + Enter to retry."));
      child.unref();
    };
    server.bindCLIShortcuts({ customShortcuts: [{ key: "a", description: "open a fresh RaytoneBot authorization entry", action: open }, { key: "o", description: "open an authorized RaytoneBot page", action: open }] });
    server.httpServer?.once("listening", open);
  };

  return {
    name: "agentcanvas-pi-runtime",
    // Created when the server starts, not on the first request: enabled IM channels must
    // reconnect after a restart even if nobody opens the page. `vite build` runs neither hook.
    configureServer(server) {
      mount(server.middlewares);
      getHost();
      userEntry(server);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
      getHost();
      userEntry(server);
    },
    async closeBundle() {
      await host?.dispose();
      host = undefined;
    },
  };
}
