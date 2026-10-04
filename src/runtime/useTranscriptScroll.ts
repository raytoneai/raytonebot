import { useLayoutEffect, useRef, type RefObject } from "react";
import type { AgentUXTimelineItem } from "@agent-ux/render-core";

export type TranscriptScroll = {
  key?: string;
  userMessages: number;
  pinned: boolean;
  lastSearchNonce?: string;
  anchor?: { index: number; offset: number };
};

/** Keep reading position across layout remounts; a new conversation or prompt follows the end. */
export function useTranscriptScroll(timeline: readonly AgentUXTimelineItem[], saved?: RefObject<TranscriptScroll | undefined>, target?: { textId: string; nonce: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const local = useRef<TranscriptScroll | undefined>(undefined);
  const memory = saved ?? local;
  const key = timeline[0]?.id;
  const userMessages = timeline.filter((item) => item.kind === "message" && item.role === "user").length;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const previous = memory.current;
    const state: TranscriptScroll = previous && previous.key === key && previous.userMessages === userMessages
      ? previous : { key, userMessages, pinned: true, lastSearchNonce: previous?.lastSearchNonce };
    memory.current = state;
    const remember = () => {
      state.pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      const top = list.getBoundingClientRect().top;
      // ponytail: scan rendered rows; index anchors if very large histories make scrolling slow.
      const index = Array.from(list.children).findIndex((child) => child.getBoundingClientRect().bottom > top);
      state.anchor = index < 0 ? undefined : { index, offset: list.children[index].getBoundingClientRect().top - top };
    };
    const toBottom = () => { list.scrollTop = list.scrollHeight; remember(); };
    if (state.pinned) toBottom();
    else if (state.anchor) {
      const child = list.children[state.anchor.index];
      if (child) list.scrollTop += child.getBoundingClientRect().top - list.getBoundingClientRect().top - state.anchor.offset;
      remember();
    }

    let frame = 0;
    const follow = () => {
      if (!state.pinned || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (state.pinned) toBottom(); });
    };
    // WritingText reveals without changing the view model; resizing a panel changes wrapping.
    const mutations = new MutationObserver(follow);
    const resize = new ResizeObserver(follow);
    list.addEventListener("scroll", remember, { passive: true });
    mutations.observe(list, { childList: true, subtree: true, characterData: true });
    resize.observe(list);
    return () => {
      list.removeEventListener("scroll", remember);
      mutations.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key, userMessages, memory]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !target) return;
    const message = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find(element => element.dataset.messageId === target.textId);
    if (!message) return; // History may still be loading.
    if (memory.current?.lastSearchNonce !== target.nonce) {
      if (memory.current) { memory.current.pinned = false; memory.current.lastSearchNonce = target.nonce; }
      list.scrollTop += message.getBoundingClientRect().top - list.getBoundingClientRect().top - 16;
    }
    message.dataset.searchMatch = "true";
    return () => { delete message.dataset.searchMatch; };
  }, [key, timeline.length, target, memory]);
  return listRef;
}
