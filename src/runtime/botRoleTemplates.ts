import type { AppLocale } from "../i18n/locales.ts";
import { featureText } from "../i18n/copy/features.ts";
import type { BotProfile } from "./botProfiles";

type Persona = Pick<BotProfile, "role" | "personality" | "instructions">;
export type BotRoleTemplate = { id: string; label: string; persona: Persona };

/** Optional starting text, never an engine/model choice or a capability grant. */
export function botRoleTemplates(locale: AppLocale): BotRoleTemplate[] {
  return [
    { id: "research", label: featureText(locale, "Research"), persona: { role: "Research products and sources, compare options, and verify claims.", personality: "Lead with the conclusion. Be concise and distinguish facts from judgment.", instructions: "Prefer primary sources, cite important claims, and clearly state what is unknown." } },
    { id: "planning", label: featureText(locale, "Planning"), persona: { role: "Clarify goals, break down tasks, and build actionable plans.", personality: "Be structured. Start with priorities and the next step.", instructions: "Identify constraints, prefer simple solutions, and define completion criteria for key steps." } },
    { id: "building", label: featureText(locale, "Building"), persona: { role: "Implement and fix specific features in my projects.", personality: "Be direct and practical. Explain changes and verification results.", instructions: "Read related code and project conventions first. Keep changes focused, preserve existing work, and run relevant checks." } },
  ];
}

/** Switching a starting point replaces only blank or still-unedited template fields. */
export function applyBotRoleTemplate(draft: BotProfile, next: Persona, previous?: Persona): BotProfile {
  const result = { ...draft };
  for (const key of ["role", "personality", "instructions"] as const) {
    if (!draft[key]?.trim() || draft[key] === previous?.[key]) result[key] = next[key];
  }
  return result;
}
