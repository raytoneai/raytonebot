import { AppleLogo, GithubLogo, GoogleLogo, RedditLogo, XLogo } from "@phosphor-icons/react";
import { ArrowUpRight, Globe, Hand, LockKeyhole, MousePointerClick, Power } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { framePoint, keyInput, mouseButton } from "../../../runtime/browserView";
import { useBrowserView } from "../../../runtime/useBrowserView";
import type { OutputFrameCopy } from "./types";

/** Moves are sent at most this often while the user drives the page. */
const MOVE_INTERVAL_MS = 60;
const LOGIN_SITES = [
  { id: "google", name: "Google", domain: "accounts.google.com", icon: GoogleLogo },
  { id: "github", name: "GitHub", domain: "github.com", icon: GithubLogo },
  { id: "reddit", name: "Reddit", domain: "reddit.com", icon: RedditLogo },
  { id: "apple", name: "Apple", domain: "account.apple.com", icon: AppleLogo },
  { id: "x", name: "X", domain: "x.com", icon: XLogo },
];

/**
 * The shared browser's live view in the Output panel (ADR-040): frames while visible, who is in
 * control, and take over / hand back. While the user holds it, pointer and keys on the frame go
 * to the page; text goes through a hidden field so IME composition works.
 */
export function BrowserView({ copy, onLoginOpen }: { copy: OutputFrameCopy; onLoginOpen?: () => void }) {
  const c = copy.browser;
  const [otherOpen, setOtherOpen] = useState(false);
  const [address, setAddress] = useState("");
  const view = useBrowserView(true);
  const frameRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const lastMove = useRef(0);
  const state = view.state;
  const controlling = state?.controller === "user";

  const point = (event: ReactPointerEvent | WheelEvent) => {
    const box = frameRef.current?.getBoundingClientRect();
    return box && view.frame ? framePoint(event.clientX, event.clientY, box, view.frame) : undefined;
  };
  const pointer = (type: "down" | "up" | "move") => (event: ReactPointerEvent) => {
    if (!controlling) return;
    if (type === "move" && Date.now() - lastMove.current < MOVE_INTERVAL_MS) return;
    const at = point(event);
    if (!at) return;
    if (type === "move") lastMove.current = Date.now();
    if (type === "down") { event.preventDefault(); textRef.current?.focus(); }
    view.input({ kind: "mouse", type, ...at, button: mouseButton(event.button) });
  };

  return (
    <div className="artifact-content browser-view" data-controller={state?.controller ?? "agent"}>
      <div className="browser-view-bar">
        <Globe size={14} aria-hidden="true" />
        <span className="browser-view-url" title={state?.url}>{state?.running ? state.title || state.url || c.view : c.view}</span>
        {state?.running ? (
          controlling ? (
            <button type="button" className="browser-view-action" data-primary="true" disabled={view.busy} onClick={() => void view.control("release")}><Hand size={14} aria-hidden="true" />{c.handBack}</button>
          ) : (
            <button type="button" className="browser-view-action" disabled={view.busy} onClick={() => void view.control("takeover")}><MousePointerClick size={14} aria-hidden="true" />{c.takeOver}</button>
          )
        ) : null}
        {state?.running ? (
          <button type="button" className="rail-icon-btn" aria-label={c.stop} title={c.stop} disabled={view.busy} onClick={() => void view.control("stop")}><Power size={14} /></button>
        ) : null}
      </div>
      {state?.requested ? <p className="browser-view-note" role="status" data-tone="warn">{c.requested(state.requested.reason)}</p> : null}
      {state?.running ? <p className="browser-view-note" role="status">{controlling ? c.youControl : c.agentControls}</p> : null}
      {view.error ? <p className="browser-view-note" role="alert" data-tone="error">{c.failed(view.error)}</p> : null}
      {state?.available && !state.running ? (
        <div className="browser-auth">
          <div className="browser-auth-heading">
            <h2>{c.loginTitle}</h2>
            <p>{c.loginIntro}</p>
          </div>
          <div className="browser-auth-providers" aria-busy={view.busy}>
            {LOGIN_SITES.map(({ id, name, domain, icon: Icon }) => (
              <button key={id} type="button" className="browser-auth-provider" data-site={id} disabled={view.busy} onClick={() => { onLoginOpen?.(); void view.login(id); }}>
                <Icon size={24} weight="fill" aria-hidden="true" />
                <span><strong>{c.login(name)}</strong><small>{domain}</small></span>
                <ArrowUpRight size={16} aria-hidden="true" />
              </button>
            ))}
            <button type="button" className="browser-auth-provider" disabled={view.busy} aria-expanded={otherOpen} onClick={() => setOtherOpen((open) => !open)}>
              <Globe size={24} aria-hidden="true" /><span><strong>{c.other}</strong><small>{c.otherHint}</small></span><ArrowUpRight size={16} aria-hidden="true" />
            </button>
            {otherOpen ? (
              <form className="browser-auth-address" onSubmit={(event) => { event.preventDefault(); onLoginOpen?.(); void view.login("other", address.trim()); }}>
                <label htmlFor="browser-login-address">{c.address}</label>
                <input id="browser-login-address" type="url" required maxLength={4096} placeholder="https://example.com" autoFocus value={address} onChange={(event) => setAddress(event.target.value)} disabled={view.busy} />
                <button type="submit" className="browser-view-action" disabled={view.busy}>{c.openAddress}</button>
              </form>
            ) : null}
          </div>
          <p className="browser-auth-footnote"><LockKeyhole size={14} aria-hidden="true" /><span>{c.loginHint}</span></p>
        </div>
      ) : (
      <div
        ref={frameRef}
        className="browser-view-frame"
        aria-label={c.view}
        role="img"
        onPointerDown={pointer("down")}
        onPointerUp={pointer("up")}
        onPointerMove={pointer("move")}
        onWheel={(event) => {
          if (!controlling) return;
          const at = point(event.nativeEvent);
          if (at) view.input({ kind: "mouse", type: "wheel", ...at, deltaX: event.deltaX, deltaY: event.deltaY });
        }}
        onContextMenu={(event) => { if (controlling) event.preventDefault(); }}
      >
        {view.frame ? <img src={view.frame.src} alt="" draggable={false} /> : (
          <p className="browser-view-empty">{!state ? c.connecting : !state.available ? c.unavailable : c.idle}</p>
        )}
        {controlling ? (
          <textarea
            ref={textRef}
            className="browser-view-keys"
            aria-label={c.view}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(event) => { const key = keyInput("down", event.nativeEvent); if (key) { event.preventDefault(); view.input(key); } }}
            onKeyUp={(event) => { const key = keyInput("up", event.nativeEvent); if (key) { event.preventDefault(); view.input(key); } }}
            onInput={(event) => {
              const field = event.currentTarget;
              if ((event.nativeEvent as InputEvent).isComposing) return;
              if (field.value) view.input({ kind: "text", text: field.value });
              field.value = "";
            }}
            onCompositionEnd={(event) => {
              if (event.data) view.input({ kind: "text", text: event.data });
              event.currentTarget.value = "";
            }}
          />
        ) : null}
      </div>
      )}
    </div>
  );
}
