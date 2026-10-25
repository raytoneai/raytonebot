import { randomUUID } from "node:crypto";
import type { VaultRequestAnswer, VaultRequestView, VaultUseResult } from "./vaultRequestTypes.ts";

export class VaultRequestError extends Error {
  readonly statusCode: number;
  constructor(message = "Invalid login input. Check the fields and try again.", statusCode = 400) {
    super(message); this.name = "VaultRequestError"; this.statusCode = statusCode;
  }
}

type Wait = {
  conversationId: string; runId: string; origin: string; items: VaultRequestView["items"]; expiresAt: number;
  signal?: AbortSignal; announce(view: VaultRequestView): void;
  execute(answer: VaultRequestAnswer): Promise<VaultUseResult>;
  /** Preserve a known save and mark an already-started fill uncertain on interruption. */
  interrupted?(): VaultUseResult;
};
type Pending = { view: VaultRequestView; options: Wait; finish(result: VaultUseResult): VaultUseResult; inFlight?: Promise<VaultUseResult>; result?: VaultUseResult };
type Receipt = { conversationId: string; runId: string; result: VaultUseResult };
const expired = (): VaultUseResult => ({ status: "expired", message: "This login request has expired. Request a new browser snapshot." });

/** Strict input parsing occurs only at the dedicated host endpoint. Never trim credentials. */
function parseAnswer(value: unknown, items: VaultRequestView["items"]): VaultRequestAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultRequestError();
  const answer = value as Record<string, unknown>;
  const keys = Object.keys(answer);
  if (answer.action === "cancel" && keys.length === 1) return { action: "cancel" };
  if (answer.action === "use" && keys.length === 2 && typeof answer.itemId === "string" && items.some(item => item.id === answer.itemId)) return { action: "use", itemId: answer.itemId };
  if (answer.action !== "fill" || keys.some(key => !["action", "username", "password", "save", "label"].includes(key))
    || typeof answer.username !== "string" || !answer.username.length || answer.username.length > 512
    || typeof answer.password !== "string" || !answer.password.length || answer.password.length > 8192
    || typeof answer.save !== "boolean"
    || (answer.label !== undefined && (typeof answer.label !== "string" || answer.label.length > 120 || /[\x00-\x1f\x7f]/.test(answer.label)))) throw new VaultRequestError();
  return { action: "fill", username: answer.username, password: answer.password, save: answer.save, ...(typeof answer.label === "string" ? { label: answer.label } : {}) };
}

/** Only active callbacks hold secret answers; receipts are bounded and contain status only. */
export class VaultRequestGate {
  private readonly pending = new Map<string, Pending>();
  private readonly receipts = new Map<string, Receipt>();
  waitingIn(conversationId: string): boolean { return this.pendingIn(conversationId).length > 0; }
  pendingIn(conversationId: string): VaultRequestView[] {
    return [...this.pending.values()].filter(entry => entry.options.conversationId === conversationId).map(entry => structuredClone(entry.view));
  }
  wait(options: Wait): Promise<VaultUseResult> {
    if (options.signal?.aborted || Date.now() >= options.expiresAt) return Promise.resolve(expired());
    if (this.waitingIn(options.conversationId)) return Promise.resolve({ status: "unavailable", message: "A login request is already pending." });
    const view: VaultRequestView = { requestId: randomUUID(), runId: options.runId, origin: options.origin, expiresAt: options.expiresAt, items: options.items.map(({ id, label }) => ({ id, label })) };
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const stop = () => entry.finish(options.interrupted?.() ?? expired());
      const entry: Pending = { view, options, finish: result => {
        if (entry.result) return entry.result;
        entry.result = { status: result.status, ...(result.saved !== undefined ? { saved: result.saved } : {}), ...(result.message ? { message: result.message } : {}) };
        clearTimeout(timer); options.signal?.removeEventListener("abort", stop); this.pending.delete(view.requestId);
        this.receipts.set(view.requestId, { conversationId: options.conversationId, runId: options.runId, result: entry.result });
        while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!);
        resolve(entry.result); return entry.result;
      } };
      this.pending.set(view.requestId, entry);
      timer = setTimeout(stop, Math.max(0, options.expiresAt - Date.now())); timer.unref();
      options.signal?.addEventListener("abort", stop, { once: true });
      try { options.announce(structuredClone(view)); } catch { entry.finish({ status: "unavailable", message: "Login request could not be shown." }); }
    });
  }
  async answer(conversationId: string, requestId: string, runId: string, value: unknown): Promise<VaultUseResult> {
    const receipt = this.receipts.get(requestId);
    if (receipt && receipt.conversationId === conversationId && receipt.runId === runId) return { ...receipt.result };
    const entry = this.pending.get(requestId);
    if (!entry || entry.options.conversationId !== conversationId || entry.view.runId !== runId) throw new VaultRequestError("Login request is no longer available.", 409);
    if (entry.inFlight) return entry.inFlight;
    if (entry.options.signal?.aborted || Date.now() >= entry.view.expiresAt) return entry.finish(expired());
    const answer = parseAnswer(value, entry.view.items);
    if (answer.action === "cancel") return entry.finish({ status: "denied" });
    // Set the lock before invoking application code; duplicate requests share the result.
    entry.inFlight = Promise.resolve().then(() => entry.result ?? entry.options.execute(answer)).then(result => entry.finish(result), error => {
      entry.inFlight = undefined;
      if (entry.result) return entry.result;
      if (entry.options.signal?.aborted || Date.now() >= entry.view.expiresAt) return entry.finish(entry.options.interrupted?.() ?? expired());
      if (error instanceof VaultRequestError) throw error;
      return entry.finish({ status: "unknown", message: "The fill outcome is uncertain. Inspect the browser before requesting again." });
    });
    return entry.inFlight;
  }
}
