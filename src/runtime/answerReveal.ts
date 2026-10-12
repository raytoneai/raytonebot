/**
 * Markdown blocks of an answer fade in once as they enter view, after Open Intelligent UI's
 * reveal. Blocks already on screen when they appear stay as they are, so opening a
 * conversation does not flash; live text keeps its own typing reveal (`WritingText`). Only
 * blocks that start off screen (history above, or an answer growing below the reader) wait
 * hidden until scrolled to. Opacity and transform only: layout and scroll anchoring are
 * unaffected. CSS in `markdownText.css`; reduced motion shows everything at once.
 */
export type RevealState = "pending" | "visible" | undefined;

/** First report: off screen hides it until seen; later: seen once means visible for good. */
export function nextRevealState(current: RevealState, intersecting: boolean, first: boolean): RevealState {
  if (first) return intersecting ? undefined : "pending";
  return current === "pending" && intersecting ? "visible" : current;
}

export function observeAnswerBlocks(root: HTMLElement): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const seen = new WeakSet<Element>();
  const tracked = new Set<Element>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const block = entry.target;
      const first = !seen.has(block);
      seen.add(block);
      const next = nextRevealState(block.getAttribute("data-answer-reveal") as RevealState, entry.isIntersecting, first);
      if (next) block.setAttribute("data-answer-reveal", next);
      if (next !== "pending") observer.unobserve(block);
    }
  }, { rootMargin: "0px 0px -24px 0px" });
  const observe = () => {
    for (const block of root.children) {
      if (tracked.has(block)) continue;
      tracked.add(block);
      observer.observe(block);
    }
  };
  observe();
  const mutations = new MutationObserver(observe);
  mutations.observe(root, { childList: true });
  return () => {
    observer.disconnect();
    mutations.disconnect();
    for (const block of tracked) block.removeAttribute("data-answer-reveal");
  };
}
