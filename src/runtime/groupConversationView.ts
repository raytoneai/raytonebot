import type { EphemeralPiConversation } from "../pi/piConversationState.ts";
import { validParticipantId } from "../pi/groupParticipants.ts";
import type { StoredConversationSummary } from "../pi/piClient.ts";

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
