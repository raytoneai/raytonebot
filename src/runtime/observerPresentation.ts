import type { EvidenceView, Finding, FollowUpReference } from "../pi/observer/types.ts";
import type { AppLocale } from "../i18n/locales.ts";
import { observerText } from "../i18n/copy/observer.ts";
import type { OutputPanelItem } from "../components/agent-preview/outputframe/panelItem.ts";
const json = (value: unknown) => JSON.stringify(value, null, 2);
export function observerFindingOutput(finding: Finding, locale: AppLocale): OutputPanelItem {
  const t = (key: Parameters<typeof observerText>[1]) => observerText(locale, key);
  return { id: `observer-finding:${finding.id}:${finding.revision}:follow-up:${finding.followUp?.revision ?? 0}`, kind: "file", ephemeral: true, observerRef: { id: finding.id, revision: finding.revision, followUpRevision: finding.followUp?.revision ?? 0, validity: finding.validity }, language: "markdown", title: `${finding.title}.md`,
    subtitle: `${finding.id} · ${finding.revision}`,
    body: `# ${finding.title}\n\n${t(finding.validity)} · ${t(finding.reviewStatus)}\n\n${t("acceptedNote")}\n\n${observerFollowUpMarkdown(finding, locale)}\n\n## ${t("facts")}\n\n${finding.facts.map(fact => `- ${fact.id} (${fact.kind}): ${json(fact.value)} · ${fact.evidenceIds.join(", ")}`).join("\n")}\n\n## ${t("inference")}\n\n${finding.inference}\n\n## ${t("action")}\n\n${t(finding.proposedAction.kind)}: ${finding.proposedAction.description}\n\n${t("target")}: ${t(finding.proposedAction.target.kind)} / ${finding.proposedAction.target.id}\n\n${t("scope")}: ${json(finding.scope)}\n\n${t("evidence")}: ${finding.evidenceRefs.map(ref => ref.id).join(", ")}\n\n${t("model")}: ${finding.model.provider} / ${finding.model.model}\n\n${t("usage")}: ${json(finding.budgetSpent)}\n\nBuild: ${finding.buildStamp.buildId} / ${finding.buildStamp.manifestHash}\n`,
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

export function observerFollowUpMarkdown(finding: Pick<Finding, "followUp">, locale: AppLocale): string {
  const t = (key: Parameters<typeof observerText>[1]) => observerText(locale, key);
  const followUp = finding.followUp;
  const references = (refs: FollowUpReference[]) => refs.length ? refs.map(ref => `- ${ref.source.conversationId} / ${ref.runId} · ${ref.harness} · ${ref.model ? `${ref.model.provider} / ${ref.model.model}` : t("unknownValue")}
  ${ref.source.instanceId} · ${ref.source.generation} · ${ref.version}`).join("\n") : t("unknownValue");
  let body = `## ${t("followUp")}\n\n${t("followUpNote")}\n\n${t("comparisonUnverified")}\n\n${t("sourceVersionNote")}\n\n`;
  if (!followUp?.implementation && !followUp?.effect) return body + (followUp?.clearedSections?.length ? t("sourceCleared") : t("noFollowUp"));
  body += `${t("recordRevision")}: ${followUp.revision}\n\n`;
  const implementation = followUp.implementation;
  if (implementation) body += `### ${t("implementation")} · ${t("userRecord")}\n\n${t("implementationStatus")}: ${t(implementation.status)}\n\n${implementation.summary}\n\n${t("linkedSources")}:\n${references(implementation.references)}\n\n${t("recordedAt")}: ${new Date(implementation.recordedAt).toLocaleString(locale)} · finding #${implementation.findingRevision}\n\n`;
  const effect = followUp.effect;
  if (effect) body += `### ${t("effect")} · ${t("userRecord")}\n\n${t("effectJudgment")}: ${t(effect.judgment)}\n\n${effect.summary}\n\n${t("successCriteria")}: ${effect.successCriteria || t("unknownValue")}\n\n${t("baseline")}:\n${references(effect.baseline)}\n\n${t("candidate")}:\n${references(effect.candidate)}\n\n${t("samples")}: ${effect.sampleSize ?? t("unknownValue")}\n\n${t("recordedCost")}: ${effect.costNotes || t("unknownValue")}\n\n${t("recordedAt")}: ${new Date(effect.recordedAt).toLocaleString(locale)} · finding #${effect.findingRevision}\n\n`;
  if (followUp.clearedSections?.length) body += `${t("sourceCleared")}\n\n`;
  return body;
}

export function observerOutputMatchesFinding(item: Pick<OutputPanelItem, "observerRef">, finding?: Pick<Finding, "id" | "revision" | "validity" | "followUp">): boolean {
  const ref = item.observerRef;
  return !ref || Boolean(finding && ref.id === finding.id && ref.revision === finding.revision && ref.validity === finding.validity
    && (ref.followUpRevision === undefined || ref.followUpRevision === (finding.followUp?.revision ?? 0)));
}
