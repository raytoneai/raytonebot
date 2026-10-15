import { GitBranch } from "lucide-react";

import type { AgentFrontendProject } from "../../schema/agentuxConfig";
import type { GitPreviewState } from "../../preview-runner/PreviewRunner";
import { useCopy } from "../../i18n/LocaleContext";

export function GitFrame(_props: {
  project: AgentFrontendProject;
  gitState?: GitPreviewState;
  onCommit?: () => void;
}) {
  const copy = useCopy();
  const c = copy.workspace.gitFrame;

  return (
    <section className="utility-card git-panel" data-preview-anchor="git">
      <header className="utility-header">
        <div>
          <h3>{c.title}</h3>
          <p>{c.subtitle}</p>
        </div>
        <GitBranch size={16} />
      </header>
    </section>
  );
}
