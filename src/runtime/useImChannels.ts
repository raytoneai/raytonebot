import { useCallback, useEffect, useRef, useState } from "react";

import { listImChannels, updateImChannel } from "../pi/piClient";
import type { ChannelModel, ChannelPatch, ChannelPlatform, ChannelView } from "../pi/imChannels/types";

export type ImChannelsState = {
  channels?: ChannelView[];
  error?: string;
  saving?: ChannelPlatform;
  saveError?: { platform: ChannelPlatform; message: string };
  save(platform: ChannelPlatform, patch: ChannelPatch): Promise<void>;
};

/**
 * IM channel settings, read from the host while the settings page is open. Status is polled
 * there (connections change on the server); every save also records the current default model
 * service, which is what chats run on.
 */
export function useImChannels(active: boolean, model: ChannelModel | undefined): ImChannelsState {
  const [channels, setChannels] = useState<ChannelView[]>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<ChannelPlatform>();
  const [saveError, setSaveError] = useState<ImChannelsState["saveError"]>();
  const locked = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  const load = useCallback(async () => {
    if (!mounted.current || locked.current) return;
    const request = ++generation.current;
    try {
      const value = await listImChannels();
      if (!mounted.current || request !== generation.current) return;
      setChannels(value);
      setError(undefined);
    } catch (failure) {
      if (mounted.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await load();
      if (!stopped) timer = window.setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => { stopped = true; generation.current++; window.clearTimeout(timer); };
  }, [active, load]);

  const save = useCallback(async (platform: ChannelPlatform, patch: ChannelPatch) => {
    if (locked.current || !mounted.current) return;
    locked.current = true;
    const request = ++generation.current;
    setSaving(platform);
    setSaveError(undefined);
    try {
      const value = await updateImChannel(platform, { ...patch, ...(modelRef.current ? { model: modelRef.current } : {}) });
      if (!mounted.current || request !== generation.current) return;
      setChannels(value);
      setError(undefined);
    } catch (failure) {
      if (mounted.current && request === generation.current) {
        setSaveError({ platform, message: failure instanceof Error ? failure.message : String(failure) });
      }
    } finally {
      locked.current = false;
      if (mounted.current) setSaving(undefined);
    }
  }, []);

  return { channels, error, saving, saveError, save };
}
