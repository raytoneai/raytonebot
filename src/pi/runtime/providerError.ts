/** Only the bounded JSON error message is exposed; never headers, HTML or auth error bodies. */
export async function providerErrorMessage(response: Response, secrets: readonly string[], timeoutMs = 1000): Promise<string> {
  const fallback = `Model provider returned HTTP ${response.status}.`;
  if (!response.body) return fallback;
  const reader = response.body.getReader();
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined); }, timeoutMs);
  try {
    if (response.status === 401 || response.status === 403) return fallback;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) return fallback;
      if (done) break;
      size += value.length;
      if (size > 16_384) return fallback;
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Google's OpenAI-compatible endpoint returns [{ error: { code, message, status } }].
    const body = Array.isArray(parsed) ? parsed[0] : parsed;
    let message = body?.error?.message ?? body?.message;
    if (typeof message !== 'string') return fallback;
    // Redact before truncation, including JSON-decoded and commonly encoded credentials.
    for (const secret of secrets.filter(Boolean)) {
      for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
        message = message.split(value).join('[redacted]');
      }
    }
    message = message.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
    return message ? `${fallback} ${message.slice(0, 600)}` : fallback;
  } catch { return fallback; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
