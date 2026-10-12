import { ARTIFACT_BRIDGE_SCRIPT } from "../../../runtime/artifactBridge.ts";

/** Opaque-origin iframe + CSP: allow local scripts, block parent access and network subresources. */
export function htmlPreviewDocument(body: string, themeCss = "", libsHead = ""): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  // First in the parser's head, including when the supplied artifact is a full document.
  // A later policy in untrusted HTML can only restrict this policy, never loosen it.
  // The bridge runs before the artifact's own scripts so they find `raytone` already there;
  // the theme comes before its styles so they override it. Library scripts and their import
  // map (`sandboxLibs.ts`) precede the page's scripts; `data:` in script-src serves only those
  // shims and grants nothing inline scripts could not already do.
  const theme = themeCss ? `<style>${themeCss.replace(/<\/style/gi, "<\\/style")}</style>` : "";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${ARTIFACT_BRIDGE_SCRIPT}</script>${theme}${libsHead}${body}`;
}
