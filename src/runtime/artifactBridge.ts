/**
 * What an HTML artifact may ask of the page around it: send a follow-up the user clicked for,
 * or open an https link. Messages come from untrusted generated code, so the shape, size and
 * scheme are checked here; the caller also checks that the message came from its own frame
 * and that the user had just clicked (the frame cannot fake the parent's user activation).
 */
export const ARTIFACT_PROMPT_LIMIT = 4000;

export type ArtifactRequest = { kind: "prompt"; text: string } | { kind: "link"; url: string };

export function parseArtifactRequest(data: unknown): ArtifactRequest | { error: string } | undefined {
  if (!data || typeof data !== "object" || (data as { raytoneArtifact?: unknown }).raytoneArtifact !== 1) return undefined;
  const { type, value } = data as { type?: unknown; value?: unknown };
  if (typeof value !== "string") return { error: "value must be a string" };
  if (type === "prompt") {
    const text = value.trim();
    if (!text) return { error: "empty prompt" };
    if (text.length > ARTIFACT_PROMPT_LIMIT) return { error: `prompt longer than ${ARTIFACT_PROMPT_LIMIT} characters` };
    return { kind: "prompt", text };
  }
  if (type === "link") {
    let url: URL;
    try { url = new URL(value); } catch { return { error: "invalid url" }; }
    if (url.protocol !== "https:") return { error: "only https links open" };
    return { kind: "link", url: url.href };
  }
  return { error: "unknown request" };
}

/**
 * Runs inside the artifact before its own code. `raytone.sendPrompt` / `raytone.openLink` post
 * to the parent and resolve with its answer; `Websandbox.connection.remote` is the same object,
 * so widgets written for Open Generative UI work unchanged.
 */
export const ARTIFACT_BRIDGE_SCRIPT = `(()=>{const ask=(type,value)=>new Promise((resolve,reject)=>{const c=new MessageChannel();c.port1.onmessage=(e)=>{c.port1.close();e.data&&e.data.ok?resolve({ok:true}):reject(new Error((e.data&&e.data.error)||"rejected"))};parent.postMessage({raytoneArtifact:1,type,value:String(value??"")},"*",[c.port2])});const arg=(v,k)=>v&&typeof v==="object"?v[k]:v;const api=Object.freeze({sendPrompt:(v)=>ask("prompt",arg(v,"text")),openLink:(v)=>ask("link",arg(v,"url"))});Object.defineProperty(window,"raytone",{value:api});window.Websandbox={connection:{remote:api}};})();`;
