import { ARTIFACT_BRIDGE_SCRIPT } from "../../../runtime/artifactBridge.ts";

/** Opaque-origin iframe + CSP: allow local scripts, block parent access and network subresources. */
const POLICY_REST = "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function htmlPreviewDocument(body: string, themeCss = "", libsHead = ""): string {
  const policy = `default-src 'none'; script-src 'unsafe-inline' data:; ${POLICY_REST}`;
  // First in the parser's head, including when the supplied artifact is a full document.
  // A later policy in untrusted HTML can only restrict this policy, never loosen it.
  // The bridge runs before the artifact's own scripts so they find `raytone` already there;
  // the theme comes before its styles so they override it. Library scripts and their import
  // map (`sandboxLibs.ts`) precede the page's scripts; `data:` in script-src serves only those
  // shims and grants nothing inline scripts could not already do.
  const theme = themeCss ? `<style>${themeCss.replace(/<\/style/gi, "<\\/style")}</style>` : "";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${ARTIFACT_BRIDGE_SCRIPT}</script>${theme}${libsHead}${body}`;
}

/**
 * Inside the live-preview frame: each update is parsed in an inert <template>, stripped of
 * anything that runs or navigates, then swapped in; a theme update replaces only the theme
 * style. Messages count only from the page around the frame.
 */
const STREAM_RECEIVER = `(()=>{const theme=document.getElementById("raytone-theme");const drop=/^(script|iframe|frame|frameset|object|embed|applet|base|meta|link|portal)$/i;const urlAttr=/^(href|src|action|formaction|xlink:href|data|poster|background|ping)$/i;const clean=(root)=>{for(const el of [...root.querySelectorAll("*")]){if(drop.test(el.localName)){el.remove();continue}for(const a of [...el.attributes]){if(/^on/i.test(a.name)||a.name.toLowerCase()==="srcdoc"||(urlAttr.test(a.name)&&/^\\s*(javascript|vbscript|data:text\\/html)/i.test(a.value)))el.removeAttribute(a.name)}}};addEventListener("message",(e)=>{if(e.source!==parent||!e.data)return;if(typeof e.data.raytoneTheme==="string")theme.textContent=e.data.raytoneTheme;if(typeof e.data.raytoneStream==="string"){const t=document.createElement("template");t.innerHTML=e.data.raytoneStream;clean(t.content);document.body.replaceChildren(t.content)}})})();`;

/**
 * The live-preview frame (`HtmlStreamPreview`): no page script may run here, since the page is
 * not saved, possibly not approved. The policy admits only the receiver, by nonce; without
 * 'unsafe-inline' the browser itself refuses event-handler attributes and javascript: URLs,
 * and the receiver strips them as well.
 */
export function htmlStreamDocument(themeCss: string, nonce: string): string {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; ${POLICY_REST}`;
  const theme = themeCss.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style id="raytone-theme">${theme}</style><script nonce="${nonce}">${STREAM_RECEIVER}</script>`;
}
