/** Bot tokens pasted into a prompt: `<bot id>:<35-char secret>`, as @BotFather issues them. */
const TELEGRAM_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;

/**
 * Credentials typed into chat are cut before the prompt is saved or sent to a model; the agent
 * then sees the marker and tells the user to revoke the token and use the secure card.
 */
export function redactCredentials(prompt: string): string {
  return prompt.replace(TELEGRAM_TOKEN, "[redacted Telegram bot token: never sent to the model]");
}
