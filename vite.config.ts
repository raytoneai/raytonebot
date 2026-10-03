import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { piRuntimePlugin } from "./src/pi/piVitePlugin.ts";

// base: "./" emits relative asset paths so the built app works when served from any
// subpath, not just the domain root.
export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 5188, strictPort: true },
  preview: { host: "127.0.0.1", port: 5188, strictPort: true },
  plugins: [react(), piRuntimePlugin()],
  resolve: {
    // The vendored @agent-ux/* packages are linked via `file:./vendor/...` and import
    // bare "react"/"react-dom". Without dedupe the bundler may resolve those from the
    // vendor folder, which has no node_modules of its own — that yields a second React
    // instance and the app dies with `Cannot read properties of null (reading 'useMemo')`.
    // Force every import to resolve from this app.
    dedupe: ["react", "react-dom"],
  },
});
