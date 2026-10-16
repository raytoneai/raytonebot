/**
 * The composer queue's entrance state.
 *
 * It lives outside React on purpose. Queueing renders twice — the local state change, then the
 * host's echo a few milliseconds later — and a flag derived per render is cleared by that second
 * render: measured on the deployed bot, `data-entering` was set and then removed 6 ms later,
 * cancelling the animation before its first frame, so no `animationstart` ever fired and the
 * entrance silently never played. Keeping the decision in a ref that only grows, and applying the
 * attribute imperatively (React does not remove an attribute it does not own), makes the entrance
 * survive the second render; `onAnimationEnd` removes the attribute once it has run.
 *
 * Two cases settle instead of entering, both of them about not replaying motion the user did not
 * cause: the first paint of a queue, because it was restored with the conversation, and a scope
 * change, because the whole queue then belongs to another conversation.
 */
export type QueueEntrance = { scope?: string; seen: Set<string> };

export function createQueueEntrance(): QueueEntrance {
  return { seen: new Set() };
}

/**
 * Whether this row is one the user just added. Read from a ref callback, which runs before the
 * effect that records the queue, so a row that has just appeared still counts as new — and a row
 * whose render is only the echo of an enqueue it already entered does not count twice.
 */
export function queueRowEnters(entrance: QueueEntrance, scope: string | undefined, id: string): boolean {
  return entrance.scope === scope && !entrance.seen.has(id);
}

/** Record what this queue has already shown. A scope change adopts the whole queue as shown. */
export function queueSeen(entrance: QueueEntrance, scope: string | undefined, ids: readonly string[]): void {
  if (entrance.scope !== scope) {
    entrance.scope = scope;
    entrance.seen = new Set(ids);
    return;
  }
  for (const id of ids) entrance.seen.add(id);
}
