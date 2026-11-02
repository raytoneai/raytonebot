import type { EvidenceView, Finding } from "../pi/observer/types.ts";
import type { AppLocale } from "../i18n/locales.ts";
import { observerText } from "../i18n/copy/observer.ts";
import type { OutputPanelItem } from "../components/agent-preview/outputframe/panelItem.ts";
const json = (value: unknown) => JSON.stringify(value, null, 2);
export function observerFindingOutput(finding: Finding, locale: AppLocale): OutputPanelItem {
  const t = (key: Parameters<typeof observerText>[1]) => observerText(locale, key);
  return { id: `observer-finding:${finding.id}:${finding.revision}`, kind: "file", ephemeral: true, observerRef: { id: finding.id, revision: finding.revision, validity: finding.validity }, language: "markdown", title: `${finding.title}.md`,
    subtitle: `${finding.id} · ${finding.revision}`,
    body: `# ${finding.title}\n\n${t(finding.validity)} · ${t(finding.reviewStatus)}\n\n${t("acceptedNote")}\n\n## ${t("facts")}\n\n${finding.facts.map(fact => `- ${fact.id} (${fact.kind}): ${json(fact.value)} · ${fact.evidenceIds.join(", ")}`).join("\n")}\n\n## ${t("inference")}\n\n${finding.inference}\n\n## ${t("action")}\n\n${t(finding.proposedAction.kind)}: ${finding.proposedAction.description}\n\n${t("target")}: ${t(finding.proposedAction.target.kind)} / ${finding.proposedAction.target.id}\n\n${t("scope")}: ${json(finding.scope)}\n\n${t("evidence")}: ${finding.evidenceRefs.map(ref => ref.id).join(", ")}\n\n${t("model")}: ${finding.model.provider} / ${finding.model.model}\n\n${t("usage")}: ${json(finding.budgetSpent)}\n\nBuild: ${finding.buildStamp.buildId} / ${finding.buildStamp.manifestHash}\n`,
  };
}
export function observerEvidenceOutput(finding: Pick<Finding, "id" | "revision">, evidenceId: string, view: EvidenceView, locale: AppLocale): OutputPanelItem {
  return { id: `observer-evidence:${finding.id}:${finding.revision}:${evidenceId}`, kind: "review", ephemeral: true, observerRef: { id: finding.id, revision: finding.revision, validity: view.validity },
    language: view.language, title: view.title, subtitle: `${view.sourceLabel} · ${observerText(locale, view.validity)} · ${observerText(locale, "readOnly")}`, body: view.text };
}

/** Observer readiness is host-owned, independent of the ordinary Bot provider catalog. */
export function conversationModelUnavailable(input: { observer: boolean; observerAvailable: boolean; providerUnavailable: boolean }, locale: AppLocale, ordinaryMessage: string): string | undefined {
  return input.observer ? input.observerAvailable ? undefined : observerText(locale, "unavailable")
    : input.providerUnavailable ? ordinaryMessage : undefined;
}
