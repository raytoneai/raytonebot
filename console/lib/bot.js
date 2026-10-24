import { randomUUID } from "node:crypto";

import { openAccess } from "./crypto.js";
import { getStore, K, parse } from "./store.js";

// What one key's page sees. The bot itself is reported by the control service (control/relay.ts),
// which holds the AgentSphere key; this side only reads those reports and queues requests for it.

/** The control service sends a heartbeat once a minute while it runs. */
export const CONTROL_STALE_MS = 3 * 60_000;

export async function load(id) {
  const [bot, access, control] = await getStore().cmd("MGET", K.bot(id), K.access(id), K.control);
  const at = Number(control) || undefined;
  return { bot: parse(bot), access: openAccess(access), control: { at, online: at !== undefined && Date.now() - at < CONTROL_STALE_MS } };
}

export function pageView(record, { bot, control }) {
  return {
    key: { hint: record.hint, label: record.label, claimedAt: record.claimedAt, keepAwake: record.keepAwake },
    bot: bot ?? null,
    control,
  };
}

/** Queues a request for the control service; it picks the queue up within seconds while it runs. */
export function enqueue(id, kind, data = {}) {
  return getStore().cmd("RPUSH", K.queue, JSON.stringify({ id: randomUUID(), key: id, kind, at: Date.now(), ...data }));
}

/**
 * The bot's own health check, timed from here. A paused sandbox answers 502 from the platform's
 * proxy without waking, so this never changes the bot's state.
 */
export async function ping(access) {
  if (!access?.url || !access.password) return { ok: false };
  const started = performance.now();
  try {
    const response = await fetch(`${access.url}/__agentcanvas/pi/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Basic ${Buffer.from(`raytonebot:${access.password}`).toString("base64")}` },
    });
    const ms = Math.round(performance.now() - started);
    if (response.status !== 200) return { ok: false, ms, status: response.status };
    const health = await response.json().catch(() => ({}));
    return { ok: health.status === "ok", ms, activeRuns: typeof health.activeRuns === "number" ? health.activeRuns : undefined };
  } catch {
    return { ok: false };
  }
}
