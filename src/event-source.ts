import { useEffect, useMemo, useState } from "react";
import type { AgentUXEvent } from "@agent-ux/protocol";

import { liveEventSource } from "./adapters/backendAdapter";
import { project } from "./exported-project";

/**
 * The single event entry point for this app.
 *
 * Fixtures are preview / development / test data — they are NOT product data, and no UI
 * component may reach for them. They are reachable only while `runtime.transport` is
 * "replay" or "mock"; with "sse" this module talks to the real backend through the
 * adapter in `./adapters/backendAdapter`. The dynamic import below keeps the fixtures out
 * of the main bundle: the build splits them into their own chunk which the live path never
 * requests. (The chunk file still ships — it just is not loaded.)
 *
 * Either way the output is the same: an array of AgentCanvas standard events, which flows
 * on through the view model and `slotRegistry` into the existing components.
 */
export const isFixtureMode = project.runtime.transport !== "sse";

type LoadedStream = { id: string; label: string; load: () => AgentUXEvent[] };

/**
 * `?stream=<id>` picks a stream with no UI involved, so screenshots and automation do not
 * depend on the dev-only picker.
 *
 * With no `?stream=`, nothing is selected and the app opens on its welcome screen. It used to
 * default to the first stream, so a freshly downloaded package opened mid-conversation —
 * showing somebody else's demo transcript instead of the product's own first impression.
 */
function requestedStreamId(streams: readonly LoadedStream[]): string {
  if (typeof window === "undefined") return "";
  const requested = new URLSearchParams(window.location.search).get("stream");
  if (!requested) return "";
  const match = streams.find(
    (item) => item.id === requested || item.id.endsWith(":" + requested),
  );
  return match ? match.id : "";
}

export type EventStreamOption = { id: string; label: string };

export type EventSourceState = {
  events: AgentUXEvent[];
  /** Empty unless a fixture mode is active. */
  streams: EventStreamOption[];
  streamId: string;
  setStreamId: (id: string) => void;
};

export function useEventSource(): EventSourceState {
  const [loaded, setLoaded] = useState<LoadedStream[]>([]);
  const [streamId, setStreamId] = useState("");
  const [liveEvents, setLiveEvents] = useState<AgentUXEvent[]>([]);

  // Preview / development only. Dynamic so the live path never loads the fixture chunk.
  useEffect(() => {
    if (!isFixtureMode) return;
    let cancelled = false;
    void import("./demo-events").then((module) => {
      if (cancelled) return;
      setLoaded(module.eventStreams);
      setStreamId((current) => current || requestedStreamId(module.eventStreams));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live backend. An unconfigured adapter yields no source, which leaves the app empty
  // rather than quietly falling back to demo data.
  useEffect(() => {
    if (isFixtureMode) return;
    const source = liveEventSource();
    if (!source) {
      console.warn(
        "[AgentCanvas] transport is \"sse\" but no live source is configured — " +
          "implement liveEventSource() in src/adapters/backendAdapter.ts.",
      );
      return;
    }
    return source.subscribe(
      (incoming) => setLiveEvents((current) => [...current, ...incoming]),
      (error) => console.error("[AgentCanvas] live event source failed:", error),
    );
  }, []);

  const events = useMemo(() => {
    if (!isFixtureMode) return liveEvents;
    const stream = loaded.find((item) => item.id === streamId);
    return stream ? stream.load() : [];
  }, [liveEvents, loaded, streamId]);

  const streams = useMemo(
    () => loaded.map((item) => ({ id: item.id, label: item.label })),
    [loaded],
  );

  return { events, streams, streamId, setStreamId };
}
