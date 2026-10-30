/** Expected conversation validation or state conflicts, distinct from host failures. */
export class ConversationRequestError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409) {
    super(message);
    this.name = "ConversationRequestError";
    this.status = status;
  }
}
