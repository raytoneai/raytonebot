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
  build: {
    rolldownOptions: {
      output: {
        // Long-lived libraries in their own chunks, so an app change does not re-hash them and
        // returning visitors keep them cached. Only libraries the first paint already needs:
        // a broad `node_modules` group would pull lazy ones (mermaid, cytoscape) into it.
        // React stays one group (react, react-dom, scheduler): split, it can load twice.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 40 },
            { name: "motion", test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/, priority: 30 },
            { name: "radix", test: /node_modules[\\/](@radix-ui|@floating-ui)[\\/]/, priority: 30 },
            { name: "icons", test: /node_modules[\\/](lucide-react|@phosphor-icons)[\\/]/, priority: 30 },
            {
              name: "markdown",
              test: /node_modules[\\/](react-markdown|remark-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|unified|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities[^\\/]*|html-url-attributes|zwitch|ccount|devlop|bail|trough|is-plain-obj|trim-lines|longest-streak|markdown-table|escape-string-regexp|estree-util-is-identifier-name|style-to-[^\\/]+|inline-style-parser)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
