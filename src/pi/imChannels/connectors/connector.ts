import type { InboundMessage } from "../channelBridge.ts";
import type { ChannelStore } from "../channelStore.ts";

/** A platform connection. `start` resolves once connected (credentials verified), rejects otherwise. */
export type ChannelConnector = {
  start(): Promise<{ botName?: string }>;
  stop(): Promise<void> | void;
};

export type ConnectorInput = {
  credentials: Record<string, string>;
  store: ChannelStore;
  onMessage(message: InboundMessage): void;
  /** Connection changes after `start`: reconnecting, recovered, or failed. */
  onState(state: "connecting" | "connected" | "error", error?: string): void;
};

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** Rejects when `promise` takes longer than `ms`, for handshakes that never call back. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
