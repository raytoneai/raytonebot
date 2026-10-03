import type { PiApprovalDecision } from "../harness/adapters/piAdapter.ts";
import type { PiPromptInput } from "./piClient.ts";
import { ApprovalMemory } from "./approvalMemory.ts";
import { classifyToolCall, type PermissionPolicy } from "./permissionPolicy.ts";

export type PiPermissionMode = NonNullable<PiPromptInput["permissionMode"]>;

type PendingApproval = {
  toolName: string;
  resolve: (decision: PiApprovalDecision) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** What an agent sees when it reaches for credentials. */
export const SECRET_REFUSAL =
  "Refused: RaytoneBot never lets agents read or change credentials (~/.raytonebot, ~/.ssh, CLI logins) or dump the environment. Continue without them.";

/** Shared by the Pi tool wrappers and the HTTP controller. */
export class PiApprovalGate {
  private mode: PiPermissionMode = "request";
  /** The agent whose "always allow" grants apply. The host keeps one gate per conversation and
   *  runs at most one turn per conversation, so a mutable scope (mode, cwd, agent) is safe. */
  private agent = "default";
  private readonly pending = new Map<string, PendingApproval>();
  private policy: PermissionPolicy;
  private readonly memory: ApprovalMemory;

  constructor(policy: PermissionPolicy, memory: ApprovalMemory = new ApprovalMemory()) {
    this.policy = policy;
    this.memory = memory;
  }

  setMode(mode: PiPermissionMode) {
    this.mode = mode;
  }

  setAgent(agent: string) {
    this.agent = agent;
  }

  /** Relative paths resolve against the running agent's own directory. */
  setCwd(cwd: string) {
    this.policy = { ...this.policy, cwd };
  }

  /** Credentials and environment dumps: refused in every mode, never asked about. */
  isRefused(toolName: string, args: unknown): boolean {
    return classifyToolCall(toolName, args, this.policy) === "secret";
  }

  /**
   * request: anything that changes the workspace asks. auto: workspace work runs; outward
   * actions ask. allow-all: nothing asks. In every mode, protected calls (agent config, the
   * bot's own code) ask, and "always allow" does not cover them. Refused calls never ask.
   */
  requiresApproval(toolName: string, args: unknown): boolean {
    const kind = classifyToolCall(toolName, args, this.policy);
    if (kind === "secret") return false;
    if (kind === "protected") return true;
    if (this.mode === "allow-all") return false;
    if (kind === "outward") return true;
    if (this.memory.has(this.agent, toolName)) return false;
    return this.mode === "request" && kind === "mutating";
  }

  async wait(toolCallId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<void> {
    if (this.isRefused(toolName, args)) throw new Error(SECRET_REFUSAL);
    if (!this.requiresApproval(toolName, args)) return;
    // The abort listener below never fires for a signal that is already aborted.
    if (signal?.aborted) throw new Error("Tool approval was cancelled.");
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
    if (decision === "always") this.memory.add(this.agent, toolName);
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
