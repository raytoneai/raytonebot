import type { AgentUXEvent } from "@agent-ux/protocol";
import type { VaultRequestAnswer, VaultRequestView, VaultUseResult } from "../pi/vaultRequestTypes.ts";

/** Events contain public metadata only; terminal events invalidate every outstanding card. */
export function pendingVaultRequest(events: readonly AgentUXEvent[]): VaultRequestView | undefined {
  const pending = new Map<string, VaultRequestView>();
  for (const event of events) {
    if (["run.started", "run.finished", "run.error"].includes(event.type)) pending.clear();
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "run.awaiting_input" && payload.vaultRequest) {
      const request = payload.vaultRequest as VaultRequestView;
      pending.set(request.requestId, request);
    }
    if (event.type === "tool.call.progress" && typeof payload.inputRequestId === "string") pending.delete(payload.inputRequestId);
  }
  return [...pending.values()].at(-1);
}

type Draft = {
  selected: string; username: string; password: string; save: boolean; label: string;
  pending: boolean; failed: boolean; result?: VaultUseResult; dismissed?: boolean;
};
const emptySecrets = { username: "", password: "", save: false, label: "" };

/** A single request's memory, never a conversation cache or a browser-storage draft. */
export function createVaultRequestDraft(request: VaultRequestView) {
  let state: Draft = { ...emptySecrets, selected: request.items[0]?.id ?? "", pending: false, failed: false };
  let generation = 0;
  let disposed = false;
  let notify = () => {};
  const update = (change: Partial<Draft>) => { state = { ...state, ...change }; notify(); };
  return {
    get state() { return state; },
    listen(listener: () => void) { disposed = false; notify = listener; },
    edit(change: Partial<Pick<Draft, "selected" | "username" | "password" | "save" | "label">>) {
      if (!disposed && !state.pending && !state.result) update({ ...change, failed: false });
    },
    dismiss() { update({ ...emptySecrets, dismissed: true }); },
    expire() {
      if (!disposed && !state.result) update({ ...emptySecrets, ...(!state.pending ? { result: { status: "expired" as const } } : {}) });
    },
    dispose() { disposed = true; generation++; notify = () => {}; state = { ...state, ...emptySecrets, pending: false }; },
    async submit(cancel: boolean, send: (answer: VaultRequestAnswer) => Promise<VaultUseResult>) {
      if (disposed || state.pending || state.result) return;
      if (!cancel && Date.now() >= request.expiresAt) { this.expire(); return; }
      if (!cancel && !state.selected && (!state.username.length || state.username.length > 512 || !state.password.length || state.password.length > 8192)) return;
      const ticket = generation;
      const answer: VaultRequestAnswer = cancel ? { action: "cancel" } : state.selected
        ? { action: "use", itemId: state.selected }
        : { action: "fill", username: state.username, password: state.password, save: state.save,
          ...(state.save && state.label.trim() ? { label: state.label.trim() } : {}) };
      update({ pending: true, failed: false, ...(cancel ? emptySecrets : {}) });
      try {
        const result = await send(answer);
        if (disposed || generation !== ticket) return;
        // Never render free-form server messages, which could contain upstream data.
        update({ ...emptySecrets, pending: false, result: { status: result.status, saved: result.saved }, dismissed: cancel });
      } catch {
        if (disposed || generation !== ticket) return;
        update({ pending: false, failed: true });
        if (Date.now() >= request.expiresAt) this.expire();
      }
    },
  };
}
