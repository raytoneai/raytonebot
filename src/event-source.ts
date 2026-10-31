import { useEffect, useMemo, useState } from "react";
import type { AgentUXEvent } from "@agent-ux/protocol";

import { project } from "./exported-project";

/**
 * The fixture-only event entry point for the preview surface.
 *
 * Fixtures are preview / development / test data — they are NOT product data, and no UI
 * component may reach for them. The fixture chunk is loaded only for an explicit development
 * `?devtools=1|true` request or a non-empty `?stream=` request. An ordinary welcome page does
 * not request it, and `runtime.transport: "sse"` does not fall back to fixtures.
 *
 * Real turns are driven by Pi in `src/pi/piClient.ts`; this module only supplies explicit
 * preview events to the existing view model and `slotRegistry` components.
 */
export const isFixtureMode = project.runtime.transport !== "sse";

type LoadedStream = { id: string; label: string; enabledSlots?: readonly string[]; load: () => AgentUXEvent[] };

function queryValue(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? "";
}

function shouldLoadFixtures(): boolean {
  if (!isFixtureMode) return false;
  if (queryValue("stream")) return true;
  if (!import.meta.env.DEV) return false;
  const devtools = queryValue("devtools");
  return devtools === "1" || devtools === "true";
}

/**
 * `?stream=<id>` picks a stream with no UI involved, so screenshots and automation do not
 * depend on the dev-only picker.
 *
 * With no `?stream=`, nothing is selected and the app opens on its welcome screen. It used to
 * default to the first stream, so a freshly downloaded package opened mid-conversation —
 * showing somebody else's demo transcript instead of the product's own first impression.
 */
function requestedStreamId(streams: readonly LoadedStream[]): string {
  const requested = queryValue("stream");
  if (!requested) return "";
  const match = streams.find(
    (item) => item.id === requested || item.id.endsWith(":" + requested),
  );
  return match ? match.id : "";
}

export type EventStreamOption = { id: string; label: string };

export type EventSourceState = {
  events: AgentUXEvent[];
  /** Empty unless the fixture chunk was explicitly loaded. */
  streams: EventStreamOption[];
  streamId: string;
  /** Optional layout settings supplied by the selected preview. */
  enabledSlots?: readonly string[];
  setStreamId: (id: string) => void;
};

export function useEventSource(): EventSourceState {
  const [loaded, setLoaded] = useState<LoadedStream[]>([]);
  const [streamId, setStreamId] = useState("");

  // Preview / development only. Dynamic so the ordinary welcome/live path never loads the fixture chunk.
  useEffect(() => {
    if (!shouldLoadFixtures()) return;
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

  const events = useMemo(() => {
    if (!isFixtureMode) return [];
    const stream = loaded.find((item) => item.id === streamId);
    return stream ? stream.load() : [];
  }, [loaded, streamId]);

  const streams = useMemo(
    () => loaded.map((item) => ({ id: item.id, label: item.label })),
    [loaded],
  );

  return { events, streams, streamId, setStreamId, enabledSlots: isFixtureMode ? loaded.find(item => item.id === streamId)?.enabledSlots : undefined };
}
