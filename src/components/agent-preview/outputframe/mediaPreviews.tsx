import { useEffect, useRef } from "react";
import type { OutputPanelItem } from "./panelItem";

type Props = { item: OutputPanelItem; onError?: () => void };

function useMediaRef<T extends HTMLMediaElement>(source?: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const player = ref.current;
    if (player && source && player.getAttribute("src") !== source) player.src = source;
    return () => { if (player) { player.pause(); player.removeAttribute("src"); player.load(); } };
  }, [source]);
  return ref;
}

export function ImageOutputPreview({ item, onError }: Props) {
  return <div className="image-output-preview" data-media-kind="image"><img src={item.mediaSrc} alt={item.title} onError={onError} /></div>;
}

export function AudioOutputPreview({ item, onError }: Props) {
  const ref = useMediaRef<HTMLAudioElement>(item.mediaSrc);
  return <div className="audio-output-preview" data-media-kind="audio"><audio ref={ref} key={item.mediaSrc} src={item.mediaSrc} controls preload="metadata" aria-label={item.title} onError={onError} /></div>;
}

export function VideoOutputPreview({ item, onError }: Props) {
  const ref = useMediaRef<HTMLVideoElement>(item.mediaSrc);
  return <div className="video-output-preview" data-media-kind="video"><video ref={ref} key={item.mediaSrc} src={item.mediaSrc} controls playsInline preload="metadata" aria-label={item.title} onError={onError} /></div>;
}
