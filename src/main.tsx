import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LocaleProvider } from "./i18n/LocaleContext";
import { IconSetProvider, IconStyleProvider } from "./agentmatrix";
import { AgentApp } from "./agent-shell";
import { project } from "./exported-project";
// Self-hosted, so the declared UI face is the one on screen (no machine has it installed).
// Split by unicode-range: only the subsets a page uses are downloaded (Latin, about 45 KB).
import "@fontsource-variable/ibm-plex-sans/wght.css";
import "./styles/app.css";
import "./styles/agentmatrix.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <LocaleProvider>
      <IconSetProvider>
        <IconStyleProvider value={project.theme.stylePreset === "native" ? "bold" : "line"}>
          <AgentApp />
        </IconStyleProvider>
      </IconSetProvider>
    </LocaleProvider>
  </ErrorBoundary>,
);
