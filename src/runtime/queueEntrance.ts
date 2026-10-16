/**
 * Which follow-up ids were genuinely appended since the last render.
 *
 * The composer queue is both restored with a conversation and appended to live, and a CSS
 * entrance on the row plays whenever the element is created — which includes the first paint
 * after switching conversations, and again after the section unmounts because the queue
 * emptied. So the caller cannot animate every "new" element: a queue that came back from
 * history would stage an entrance as if the user had just queued it.
 *
 * Only a pure append counts: the previous ids must still be the unchanged head of the new list,
 * and the list must have grown. That rejects the two cases we care about — the first paint
 * (`previous` is empty) and another conversation's queue (the shared prefix differs) — and it
 * deliberately errs towards not animating when a submission and an enqueue land in the same
 * render, which would look like a list replacement rather than an append.
 *
 * Pure, so the queue's entrance is testable without a DOM: see queueEntrance.test.ts.
 */
export function appendedIds(previous: readonly string[], ids: readonly string[]): string[] {
  if (previous.length === 0 || ids.length <= previous.length) return [];
  for (let i = 0; i < previous.length; i += 1) {
    if (previous[i] !== ids[i]) return [];
  }
  return ids.slice(previous.length);
}
