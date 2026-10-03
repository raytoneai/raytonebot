/**
 * Keep the bot's own secrets out of agent-run processes. Node-only.
 *
 * An agent's shell inherits its parent's environment, so anything left there (the access
 * password, the E2B team key, model API keys) is one `env` away from a prompt-injected
 * exfiltration. Harness processes that need a credential get it re-added explicitly.
 */
const SECRET_KEY_PATTERN = /(^|_)(API_KEY|TOKEN|SECRET|SECRET_KEY|SECRET_ACCESS_KEY|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIALS)$/i;

export function isSecretEnvKey(key: string): boolean {
  return key.startsWith("E2B_") || key.startsWith("RAYTONEBOT_PASSWORD") || SECRET_KEY_PATTERN.test(key);
}

/** A copy of `env` without secrets, except the names in `keep`. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const kept = new Set(keep);
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSecretEnvKey(key) && !kept.has(key)) continue;
    next[key] = value;
  }
  return next;
}
