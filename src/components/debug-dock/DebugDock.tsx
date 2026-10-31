import type { AgentUXEvent } from "@agent-ux/protocol";
import type { AgentUXViewModel } from "@agent-ux/render-core";

import { useCopy } from "../../i18n/LocaleContext";
import {
  admissionSeverity,
  describeAdmission,
  hasAdmissionFindings,
  type Admission,
} from "../../runtime/admissionReport";

/** Dev-only read-only event and admission preview; keep it collapsed so the chat remains visible. */
export function DebugDock({
  events,
  viewModel,
  admission,
}: {
  events: readonly AgentUXEvent[];
  viewModel: AgentUXViewModel;
  admission?: Admission;
}) {
  const copy = useCopy();
  const findings = admission && hasAdmissionFindings(admission) ? admission : undefined;
  return (
    <section className="debug-dock">
      <details className="debug-details">
        <summary className="debug-header debug-summary">
          <div className="debug-summary-content">
            <div>
              <h3>{copy.workspace.debugDock.title}</h3>
              <p>{copy.workspace.debugDock.subtitle}</p>
            </div>
            <span>{events.length}{copy.workspace.debugDock.eventsSuffix}</span>
          </div>
        </summary>
        <div className="debug-grid">
          <div className="debug-pane">
            <h4>{copy.workspace.debugDock.timeline}</h4>
            <div className="event-rows">
              {events.map((event) => (
                <div key={event.id} className="event-row">
                  <code>{event.seq}</code>
                  <span>{event.type}</span>
                  <em>{event.visibility ?? copy.workspace.debugDock.visibilityDefault}</em>
                </div>
              ))}
            </div>
          </div>
          <div className="debug-pane">
            <h4>{copy.workspace.debugDock.viewModel}</h4>
            <pre>{JSON.stringify({
              runId: viewModel.runId,
              status: viewModel.status,
              timeline: viewModel.timeline.length,
              capabilities: viewModel.capabilities.length,
              errors: viewModel.errors.length,
            }, null, 2)}</pre>
          </div>
          {findings ? (
            <div className="debug-pane debug-pane-wide" data-severity={admissionSeverity(findings)}>
              <h4>{copy.workspace.debugDock.admission}</h4>
              <pre>{describeAdmission(findings)}</pre>
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}
