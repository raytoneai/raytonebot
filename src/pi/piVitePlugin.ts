import type { Plugin } from "vite";

import { PI_API_PREFIX } from "./piClient.ts";
import { createPiHttpHost } from "./piHost.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "./workspaceLayout.ts";
import { sameOriginRequestAllowed } from "./requestOrigin.ts";

export { sameOriginRequestAllowed } from "./requestOrigin.ts";

/** Mount Pi into both `vite dev` and `vite preview`; the React bundle never imports the SDK. */
export function piRuntimePlugin(options: { cwd?: string } = {}): Plugin {
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
      host = createPiHttpHost({ cwd: layout.agents.assistant, appRoot, layout });
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
        res.end(JSON.stringify({ error: "Cross-origin Pi requests are not allowed." }));
        return;
      }
      void getHost().handle(req, res).catch(next);
    });
  };

  return {
    name: "agentcanvas-pi-runtime",
    // Created when the server starts, not on the first request: enabled IM channels must
    // reconnect after a restart even if nobody opens the page. `vite build` runs neither hook.
    configureServer(server) {
      mount(server.middlewares);
      getHost();
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
      getHost();
    },
    closeBundle() {
      host?.dispose();
      host = undefined;
    },
  };
}
