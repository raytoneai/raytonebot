import { useEffect, useRef, useState } from "react";
import { PI_API_PREFIX } from "../pi/piClient";
import type { ArtifactCatalogPage } from "./artifactCatalog";

type State = ArtifactCatalogPage & { status: "loading" | "ready" | "failed"; more: boolean; error?: string };
const empty: State = { artifacts: [], truncated: false, unreadable: 0, status: "loading", more: false };

export function useArtifactCatalog(active: boolean, query: string, conversationId: string) {
  const [state, setState] = useState<State>(empty);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const key = `${conversationId}\n${query}`;
  const latest = useRef(key); latest.current = key;
  const load = async (cursor?: string) => {
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    const ticket = ++generation.current, startKey = key;
    setState(current => cursor ? { ...current, more: true, error: undefined } : { ...empty });
    try {
      const params = new URLSearchParams({ query, limit: "50", ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${PI_API_PREFIX}/artifacts?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok) throw new Error(String(response.status));
      const page = await response.json() as ArtifactCatalogPage;
      if (ticket !== generation.current || latest.current !== startKey || controller.signal.aborted) return;
      setState(current => ({ ...page, artifacts: cursor
        ? [...new Map([...current.artifacts, ...page.artifacts].map(row => [JSON.stringify([row.conversationId, row.artifactId]), row])).values()]
        : page.artifacts, status: "ready", more: false }));
    } catch {
      if (ticket !== generation.current || latest.current !== startKey || controller.signal.aborted) return;
      setState(current => ({ ...current, status: cursor ? "ready" : "failed", more: false, error: "failed" }));
    }
  };
  useEffect(() => {
    if (!active) return;
    setState(empty);
    const timer = window.setTimeout(() => void load(), 200);
    return () => { window.clearTimeout(timer); generation.current++; request.current?.abort(); };
  }, [active, key, revision]);
  return { ...state, refresh: () => setRevision(value => value + 1), loadMore: () => { if (state.nextCursor && !state.more) void load(state.nextCursor); } };
}
