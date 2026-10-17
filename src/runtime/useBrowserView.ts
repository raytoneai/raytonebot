import { useCallback, useEffect, useRef, useState } from "react";

import { BROWSER_STREAM_URL, browserLogin, browserControl, getBrowserState, sendBrowserInput } from "../pi/piClient";
import type { BrowserInput, BrowserViewState } from "../pi/browser/browserProtocol";

export type BrowserViewModel = {
  state?: BrowserViewState;
  /** The latest frame as a data URL, with its size in page pixels. */
  frame?: { src: string; width: number; height: number };
  connected: boolean;
  error?: string;
  busy: boolean;
  control(action: "takeover" | "release" | "stop" | "clear-logins"): Promise<void>;
  login(site: string, url?: string): Promise<void>;
  input(input: BrowserInput): void;
};

/**
 * The shared browser's live view (ADR-040). The stream is open only while `visible` and the page
 * is in the foreground, so the host encodes frames only when someone is looking.
 */
export function useBrowserView(visible: boolean): BrowserViewModel {
  const [state, setState] = useState<BrowserViewState>();
  const [frame, setFrame] = useState<BrowserViewModel["frame"]>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [foreground, setForeground] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");

  useEffect(() => {
    const update = () => setForeground(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!visible || !foreground) { setConnected(false); return; }
    const source = new EventSource(BROWSER_STREAM_URL);
    source.addEventListener("open", () => setConnected(true));
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("state", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as BrowserViewState;
      setState(next);
      if (!next.running) setFrame(undefined);
    });
    source.addEventListener("frame", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as { data: string; width: number; height: number };
      setFrame({ src: `data:image/jpeg;base64,${next.data}`, width: next.width, height: next.height });
    });
    return () => { source.close(); setConnected(false); };
  }, [visible, foreground]);

  // The state alone (available or not) is enough for the switch before the view opens.
  useEffect(() => { if (visible && !state) void getBrowserState().then(setState, () => undefined); }, [visible, state]);

  const control = useCallback(async (action: "takeover" | "release" | "stop" | "clear-logins") => {
    setBusy(true);
    setError(undefined);
    try { setState(await browserControl(action)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, []);

  const login = useCallback(async (site: string, url?: string) => {
    setBusy(true);
    setError(undefined);
    try { setState(await browserLogin(site, url)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, []);

  // One queue: a click's down, moves and up must reach the page in order.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const input = useCallback((value: BrowserInput) => {
    chain.current = chain.current.then(() => sendBrowserInput(value))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, []);

  return { state, frame, connected, error, busy, control, login, input };
}
