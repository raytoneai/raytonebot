import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BROWSER_STREAM_URL, browserControl, browserLogin, browserSelectTab, getBrowserState, sendBrowserInputs } from "../pi/piClient";
import type { BrowserInput, BrowserViewState } from "../pi/browser/browserProtocol";
import { createBrowserInputQueue } from "./browserView";

export type BrowserViewModel = {
  state?: BrowserViewState;
  /** The latest frame as a data URL, with its size in page pixels. */
  frame?: { src: string; width: number; height: number; pageId?: string; seq?: number; capturedAt?: number; receivedAt: number };
  connected: boolean;
  error?: string;
  busy: boolean;
  control(action: "takeover" | "release" | "stop" | "clear-logins"): Promise<void>;
  login(site: string, url?: string): Promise<void>;
  selectTab(pageId: string): Promise<void>;
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
  const lastFrameSeq = useRef(0);
  const activePage = useRef<string | undefined>(undefined);
  const controlEpoch = useRef(0);
  const inputTarget = useRef<{ pageId?: string; controlEpoch?: number }>({});
  const [foreground, setForeground] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const acceptState = useCallback((next: BrowserViewState) => {
    if (next.controlEpoch !== undefined && next.controlEpoch < controlEpoch.current) return;
    controlEpoch.current = next.controlEpoch ?? 0;
    setState(next);
    if (!next.running || next.pageId !== activePage.current) { setFrame(undefined); lastFrameSeq.current = 0; }
    activePage.current = next.pageId;
  }, []);

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
      acceptState(JSON.parse((event as MessageEvent<string>).data) as BrowserViewState);
    });
    source.addEventListener("frame", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as { data: string; width: number; height: number; pageId?: string; seq?: number; capturedAt?: number };
      if (next.pageId && next.pageId !== activePage.current) return;
      if (next.seq && next.seq <= lastFrameSeq.current) return;
      lastFrameSeq.current = next.seq ?? 0;
      setFrame({ src: `data:image/jpeg;base64,${next.data}`, width: next.width, height: next.height, pageId: next.pageId, seq: next.seq, capturedAt: next.capturedAt, receivedAt: Date.now() });
    });
    return () => { source.close(); setConnected(false); };
  }, [visible, foreground, acceptState]);

  // The state alone (available or not) is enough for the switch before the view opens.
  useEffect(() => { if (visible && !state) void getBrowserState().then(acceptState, () => undefined); }, [visible, state, acceptState]);

  const inputs = useMemo(() => createBrowserInputQueue((batch, signal) => sendBrowserInputs(batch, signal, fetch, inputTarget.current), (failure) => setError(failure instanceof Error ? failure.message : String(failure))), []);
  useEffect(() => () => inputs.reset(), [inputs]);
  useEffect(() => { if (state?.controller !== "user" || !visible || !foreground) inputs.reset(); }, [state?.controller, visible, foreground, inputs]);

  const control = useCallback(async (action: "takeover" | "release" | "stop" | "clear-logins") => {
    inputs.reset();
    setBusy(true);
    setError(undefined);
    try { acceptState(await browserControl(action)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, [inputs, acceptState]);

  const login = useCallback(async (site: string, url?: string) => {
    setBusy(true);
    setError(undefined);
    try { acceptState(await browserLogin(site, url)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, [acceptState]);


  const selectTab = useCallback(async (pageId: string) => {
    inputs.reset();
    setFrame(undefined);
    activePage.current = undefined;
    setBusy(true); setError(undefined);
    try { acceptState(await browserSelectTab(pageId)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, [inputs, acceptState]);

  const input = (event: BrowserInput) => {
    if (busy || state?.controller !== "user" || !frame || frame.pageId !== state.pageId) return;
    if (inputTarget.current.pageId !== state.pageId || inputTarget.current.controlEpoch !== state.controlEpoch) inputs.reset();
    inputTarget.current = { pageId: state.pageId, controlEpoch: state.controlEpoch };
    inputs.input(event);
  };
  return { state, frame, connected, error, busy, control, login, selectTab, input };
}
