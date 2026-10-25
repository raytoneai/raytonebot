/** Redact page-controlled text in one pass; repeated host/worker checks keep the marker intact. */
export function createBrowserRedactor(secrets: ReadonlySet<string>): (text: string) => string {
  let size = -1;
  let pattern: RegExp | undefined;
  return (text) => {
    if (size !== secrets.size) {
      size = secrets.size;
      const escaped = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
        .map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = escaped.length ? new RegExp(`\\[redacted\\]|${escaped.join("|")}`, "g") : undefined;
    }
    return pattern ? text.replace(pattern, "[redacted]") : text;
  };
}

/** Playwright's AI snapshot is line-oriented YAML. Only names and values are page text;
 * roles, state flags and refs are protocol. Quoted YAML keys double embedded apostrophes.
 * Unknown lines are still redacted rather than treated as trusted syntax. */
export function redactBrowserSnapshot(snapshot: string, redact: (text: string) => string): string {
  return snapshot.split("\n").map(line => {
    const entry = /^(\s*- )('(?:[^']|'')*'|(?:[a-z]+|\/[a-z]+)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]\r\n]+\])*)(?::(.*))?$/.exec(line);
    if (!entry) return redact(line);
    const [, indent, encodedKey, value] = entry;
    const quoted = encodedKey.startsWith("'");
    const key = quoted ? encodedKey.slice(1, -1).replace(/''/g, "'") : encodedKey;
    const safeKey = key.replace(/"(?:[^"\\]|\\.)*"/g, name => JSON.stringify(redact(JSON.parse(name) as string)));
    return indent + (quoted ? `'${safeKey.replace(/'/g, "''")}'` : safeKey) + (value === undefined ? "" : `:${redact(value)}`);
  }).join("\n");
}
