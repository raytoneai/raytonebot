import { isGroupConversation, type EphemeralPiConversation } from "../pi/piConversationState.ts";
import { validParticipantId } from "../pi/groupParticipants.ts";
import type { StoredConversationSummary } from "../pi/piClient.ts";
import { isGroupRosterTitle, groupRosterTitle } from "../i18n/copy/features.ts";
import type { AppLocale } from "../i18n/locales.ts";
import type { AgentPresetId } from "../pi/harnessCatalog.ts";
import type { AvatarKind } from "../avatars/AgentPersona.tsx";

// Group chat: members and the last message come with the host's summary of the conversation.
export function groupFields(entry: object): Pick<EphemeralPiConversation, "groupMembers" | "groupParticipants" | "groupHostId" | "groupPreview" | "botId" | "availableBots" | "titleSource" | "groupTitlePreserved"> {
  const group = (entry as StoredConversationSummary).group;
  const saved = entry as StoredConversationSummary;
  return { ...(saved.titleSource ? { titleSource: saved.titleSource } : {}), ...(saved.botId ? { botId: saved.botId, availableBots: saved.availableBots } : {}), ...(group ? { groupMembers: group.members, groupParticipants: group.participants, groupHostId: group.hostId, groupPreview: group.preview, ...(group.preserveTitle !== undefined ? { groupTitlePreserved: group.preserveTitle } : {}) } : {}) };
}

// Group chat: members live on the conversation; the host keeps its own copy per turn.
export function groupMembersOf(conversation: EphemeralPiConversation): string[] {
  const members = (conversation.groupMembers ?? []).filter(validParticipantId);
  return members.length ? members : ["assistant", "planner", "builder"];
}

export function groupConversationTitle(
  conversation: EphemeralPiConversation,
  locale: AppLocale,
  configuredBots: readonly { id: string; name: string }[],
  legacyName: (id: string) => string,
): string {
  if (!isGroupConversation(conversation) || conversation.titleSource || conversation.groupTitlePreserved) return conversation.title;
  const members = groupMembersOf(conversation);
  const names = members.map(id => configuredBots.find(bot => bot.id === id)?.name
    ?? conversation.groupParticipants?.find(bot => bot.id === id)?.name ?? id);
  const originalNames = members.map(legacyName);
  return [names, originalNames].some(roster => isGroupRosterTitle(conversation.title, roster))
    ? groupRosterTitle(names, locale) : conversation.title;
}

export function groupConversationPreviews(
  conversations: readonly EphemeralPiConversation[],
  currentName: (id: string) => string,
  legacyName: (id: string) => string,
): Record<string, string> {
  return Object.fromEntries(conversations.flatMap(entry => entry.groupPreview && isGroupConversation(entry) && !entry.titleSource && !entry.groupTitlePreserved
    && [groupMembersOf(entry).map(currentName), groupMembersOf(entry).map(legacyName)]
      .some(names => isGroupRosterTitle(entry.title, names))
    ? [[entry.id, entry.groupPreview.text.replace(/\s+/g, " ").trim()]] : []));
}

export function groupConversationFaces(
  conversations: readonly EphemeralPiConversation[],
  avatars: Record<AgentPresetId, AvatarKind>,
  presetId: (id: string) => AgentPresetId,
): Record<string, AvatarKind[]> {
  return Object.fromEntries(conversations.filter(isGroupConversation)
    .map(entry => [entry.id, groupMembersOf(entry).map(id => avatars[presetId(id)])]));
}
