import { useSyncExternalStore } from 'react';
import { BOT_STORAGE_KEY, parseBotAppearances, type BotAppearances } from './botAppearance';
const changed = 'raytone-bot-appearances';
function snapshot() { try { return localStorage.getItem(BOT_STORAGE_KEY); } catch { return null; } }
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === BOT_STORAGE_KEY || event.key === null) notify(); };
  window.addEventListener('storage', storage);
  window.addEventListener(changed, notify);
  return () => { window.removeEventListener('storage', storage); window.removeEventListener(changed, notify); };
}
export function useBotAppearances() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  return parseBotAppearances(raw);
}
export function saveBotAppearances(value: BotAppearances) {
  localStorage.setItem(BOT_STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(changed));
}
