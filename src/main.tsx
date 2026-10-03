import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LocaleProvider } from "./i18n/LocaleContext";
import { IconSetProvider, IconStyleProvider } from "./agentmatrix";
import { AgentApp } from "./agent-shell";
import { project } from "./exported-project";
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
