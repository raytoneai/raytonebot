/**
 * Group chat `@` completion in the composer: which members match what is being typed at the
 * caret, and the text after picking one. Pure, so the composer stays presentational.
 *
 * The left boundary matches the host's mention parsing (`MENTION` in src/pi/groupChat.ts): an `@`
 * after a letter, digit or `._%+-` is part of an e-mail address, not a mention.
 */
export type MentionCandidate = { id: string; name: string };

export type MentionQuery = { start: number; end: number; query: string };

const QUERY = /(?:^|[^A-Za-z0-9._%+-])@([A-Za-z]*)$/;

/** The `@word` that ends at the caret, if any. */
export function mentionQuery(text: string, caret: number): MentionQuery | undefined {
  const match = QUERY.exec(text.slice(0, caret));
  if (!match) return undefined;
  // A completed name followed by more letters ("@Raerx") is not a query for that name.
  const end = caret + (/^[A-Za-z]*/.exec(text.slice(caret))?.[0].length ?? 0);
  return { start: caret - match[1].length - 1, end, query: match[1] };
}

/** Members whose name starts with the query, in group order; nothing once a name is typed in full. */
export function mentionMatches<T extends MentionCandidate>(members: readonly T[], query: string): T[] {
  const lower = query.toLowerCase();
  const matches = members.filter((member) => member.name.toLowerCase().startsWith(lower));
  return matches.length === 1 && matches[0].name.toLowerCase() === lower ? [] : matches;
}

/** Replaces the `@query` with `@Name ` and returns where the caret goes. */
export function applyMention(text: string, at: MentionQuery, name: string): { text: string; caret: number } {
  const rest = text.slice(at.end);
  const inserted = `@${name}${rest.startsWith(" ") ? "" : " "}`;
  return { text: text.slice(0, at.start) + inserted + rest, caret: at.start + inserted.length + (rest.startsWith(" ") ? 1 : 0) };
}
