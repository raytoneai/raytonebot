import type { AgentUXEvent } from "@agent-ux/protocol";

/**
 * Backend adapter seam.
 *
 * UI components in this package never see backend payloads. They only ever consume the
 * view model produced from AgentCanvas standard events, so any backend — Claude, Codex,
 * OpenAI, LangGraph, or your own — plugs in here by translating its raw payloads into
 * StandardEvent values. Nothing downstream needs to change.
 *
 *   backend raw payload
 *     -> BackendEventAdapter.toStandardEvents()      <-- you implement this
 *     -> StandardEvent (AgentUX protocol)
 *     -> projector / view model
 *     -> slotRegistry -> existing UI components
 *
 * Already-supported states: text, reasoning, tool call lifecycle (including approval),
 * artifacts, errors, retries and interrupts. Emit the matching standard event and the
 * existing component renders it — do not build new UI for a new backend.
 */

/** The one event shape every UI component in this package understands. */
export type StandardEvent = AgentUXEvent;

export type BackendEventAdapter = {
  /**
   * Translate one raw backend payload into zero or more standard events.
   * Return [] for keep-alives and anything with no UI meaning.
   */
  toStandardEvents(raw: unknown): StandardEvent[];
};

export type LiveEventSource = {
  /** Returns an unsubscribe function. */
  subscribe(
    onEvents: (events: StandardEvent[]) => void,
    onError?: (error: unknown) => void,
  ): () => void;
};

/**
 * Pass-through adapter: use it when your endpoint already emits AgentCanvas standard
 * events. Replace it with your own translation for any other backend.
 */
export const passthroughAdapter: BackendEventAdapter = {
  toStandardEvents(raw) {
    return raw && typeof raw === "object" ? [raw as StandardEvent] : [];
  },
};

export type SseEventSourceOptions = {
  /** Stream URL, e.g. "/v1/sessions/abc/events/stream". */
  url: string;
  adapter?: BackendEventAdapter;
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
};

/**
 * Minimal `text/event-stream` (or newline-delimited JSON) reader. Each `data:` line is
 * parsed as JSON and handed to the adapter.
 *
 * If your backend already speaks the AgentMatrix protocol, you can instead use
 * `createBackendStreamSource` from `./agentmatrix` and convert its durable events with
 * `toAgentUXEvents` — both ship in this package.
 */
export function createSseEventSource(options: SseEventSourceOptions): LiveEventSource {
  const adapter = options.adapter ?? passthroughAdapter;
  const fetcher = options.fetcher ?? fetch;

  return {
    subscribe(onEvents, onError) {
      const controller = new AbortController();

      void (async () => {
        try {
          const response = await fetcher(options.url, {
            method: "GET",
            headers: { Accept: "text/event-stream", ...(options.headers ?? {}) },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error("Event stream failed: " + response.status);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split(/\r?\n\r?\n|\r?\n/);
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.startsWith("data:") ? part.slice(5).trim() : part.trim();
              if (!line || line === "[DONE]") continue;
              try {
                const events = adapter.toStandardEvents(JSON.parse(line));
                if (events.length > 0) onEvents(events);
              } catch {
                // Ignore keep-alive / comment lines.
              }
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) onError?.(error);
        }
      })();

      return () => controller.abort();
    },
  };
}

/**
 * Wire your backend here. Returning `null` (the default) leaves the app with no live
 * source, which is why an unconfigured `transport: "sse"` export renders an empty
 * conversation instead of silently falling back to demo data.
 */
export function liveEventSource(): LiveEventSource | null {
  // return createSseEventSource({ url: "/v1/sessions/current/events/stream" });
  return null;
}
