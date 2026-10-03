import type { PiApprovalDecision } from "../harness/adapters/piAdapter.ts";
import type { PiPromptInput } from "./piClient.ts";
import { classifyToolCall, type PermissionPolicy } from "./permissionPolicy.ts";

export type PiPermissionMode = NonNullable<PiPromptInput["permissionMode"]>;

type PendingApproval = {
  toolName: string;
  resolve: (decision: PiApprovalDecision) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** Shared by the Pi tool wrappers and the HTTP controller. */
export class PiApprovalGate {
  private mode: PiPermissionMode = "request";
  /** "Always allow" decisions are per-conversation: an allow in one session must not
   *  silently approve the same tool in another (or in a fresh session). */
  private readonly alwaysByConversation = new Map<string, Set<string>>();
  private conversationId = "default";
  private readonly pending = new Map<string, PendingApproval>();

  setMode(mode: PiPermissionMode) {
    this.mode = mode;
  }

  /** The conversation whose always-decisions `requiresApproval`/`wait` consult. A single
   *  run is active at a time (the controller enforces it), so a mutable scope is safe. */
  setConversation(conversationId: string) {
    this.conversationId = conversationId;
  }

  /** A new session starts with an empty approval memory. */
  resetConversation(conversationId: string) {
    this.alwaysByConversation.delete(conversationId);
  }

  private alwaysApproved() {
    let allowed = this.alwaysByConversation.get(this.conversationId);
    if (!allowed) {
      allowed = new Set();
      this.alwaysByConversation.set(this.conversationId, allowed);
    }
    return allowed;
  }

  private policy: PermissionPolicy;

  constructor(policy: PermissionPolicy) {
    this.policy = policy;
  }

  /** Relative paths resolve against the running agent's own directory. */
  setCwd(cwd: string) {
    this.policy = { ...this.policy, cwd };
  }

  /**
   * request: anything that changes the workspace asks. auto: workspace work runs; outward
   * actions ask. allow-all: nothing asks. In every mode, protected calls (credentials, the
   * bot's own code, environment dumps) ask, and "always allow" does not cover them.
   */
  requiresApproval(toolName: string, args: unknown): boolean {
    const kind = classifyToolCall(toolName, args, this.policy);
    if (kind === "protected") return true;
    if (this.mode === "allow-all") return false;
    if (kind === "outward") return true;
    if (this.alwaysApproved().has(toolName)) return false;
    return this.mode === "request" && kind === "mutating";
  }

  async wait(toolCallId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<void> {
    if (!this.requiresApproval(toolName, args)) return;
    const decision = await new Promise<PiApprovalDecision>((resolve, reject) => {
      const onAbort = () => reject(new Error("Tool approval was cancelled."));
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(toolCallId, { toolName, resolve, reject, cleanup });
    }).finally(() => {
      const pending = this.pending.get(toolCallId);
      pending?.cleanup();
      this.pending.delete(toolCallId);
    });
    if (decision === "no") throw new Error("Tool execution was denied by the user.");
    if (decision === "always") this.alwaysApproved().add(toolName);
  }

  resolve(toolCallId: string, decision: PiApprovalDecision): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
  }

  cancelAll(message = "Pi run ended before approval was decided.") {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}
