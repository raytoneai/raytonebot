import { randomUUID } from "node:crypto";
import { userAnswers, type PendingUserInput, type UserAnswers, type UserQuestion } from "../runtime/userInput.ts";

/** Questions never consult permission mode or remembered tool approvals. */
export class UserInputGate {
  private pending = new Map<string, { conversationId: string; questions: UserQuestion[]; resolve(answer: UserAnswers): void }>();
  private receipts = new Map<string, { conversationId: string; questions: UserQuestion[]; answer: string }>();

  async wait(conversationId: string, toolCallId: string, questions: UserQuestion[], signal: AbortSignal,
    announce: (request: PendingUserInput) => void, answered: (answer: UserAnswers) => void = () => {}): Promise<UserAnswers> {
    signal.throwIfAborted();
    const requestId = randomUUID();
    let abort = () => {};
    try {
      return await new Promise<UserAnswers>((resolve, reject) => {
        abort = () => { this.pending.delete(requestId); reject(new Error("User input was cancelled.")); };
        signal.addEventListener("abort", abort, { once: true });
        this.pending.set(requestId, { conversationId, questions, resolve: (answer) => { answered(answer); resolve(answer); } });
        announce({ requestId, toolCallId, questions });
      });
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending.delete(requestId);
    }
  }

  resolve(conversationId: string, requestId: string, value: unknown): boolean {
    const entry = this.pending.get(requestId) ?? this.receipts.get(requestId);
    if (!entry || entry.conversationId !== conversationId) return false;
    const answer = userAnswers(value, entry.questions);
    const encoded = JSON.stringify(answer);
    if ("answer" in entry) return entry.answer === encoded;
    // Store a bounded receipt before resolving: a lost HTTP response must not answer twice.
    entry.resolve(answer); // Persist/publish the response before acknowledging its HTTP request.
    this.receipts.set(requestId, { conversationId, questions: entry.questions, answer: encoded });
    if (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
    this.pending.delete(requestId);
    return true;
  }
}
