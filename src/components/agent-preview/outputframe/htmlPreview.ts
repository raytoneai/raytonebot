/** Opaque-origin iframe + CSP: allow local scripts, block parent access and network subresources. */
export function htmlPreviewDocument(body: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  // First in the parser's head, including when the supplied artifact is a full document.
  // A later policy in untrusted HTML can only restrict this policy, never loosen it.
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${body}`;
}
