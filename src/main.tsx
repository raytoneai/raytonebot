import { consumeControlPlaneEntry, controlPlaneSession } from "./runtime/controlPlaneSession";
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

let entry = consumeControlPlaneEntry(window.location, window.history);
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(
  <ErrorBoundary>
    <LocaleProvider>
      <IconSetProvider>
        <IconStyleProvider value={project.theme.stylePreset === "native" ? "bold" : "line"}>
          <AgentApp key={controlPlaneSession.getSnapshot().epoch} />
        </IconStyleProvider>
      </IconSetProvider>
    </LocaleProvider>
  </ErrorBoundary>,
);

const query = new URLSearchParams(window.location.search);
const fixture = Boolean(query.get("stream")) || import.meta.env.DEV && ["1", "true"].includes(query.get("devtools") ?? "");
const initialization = fixture ? Promise.resolve() : controlPlaneSession.initialize(entry);
entry = undefined;
void initialization.then(() => {
  controlPlaneSession.subscribe(render);
  render();
});
