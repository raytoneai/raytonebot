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
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () => listImChannels().then((value) => {
      if (cancelled) return;
      setChannels(value);
      setError(undefined);
    }, (failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);

  const save = useCallback(async (platform: ChannelPlatform, patch: ChannelPatch) => {
    setSaving(platform);
    setSaveError(undefined);
    try {
      setChannels(await updateImChannel(platform, { ...patch, ...(modelRef.current ? { model: modelRef.current } : {}) }));
    } catch (failure) {
      setSaveError({ platform, message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setSaving(undefined);
    }
  }, []);

  return { channels, error, saving, saveError, save };
}
