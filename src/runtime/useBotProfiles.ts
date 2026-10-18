import { useMemo, useSyncExternalStore } from "react";
import { useBotAppearances } from "./useBotAppearances";
import { BOT_PROFILES_KEY, parseBotProfiles, resolveBotProfiles, updateBotProfile, type BotProfile, type BotProfileStore } from "./botProfiles";

const changed = "raytone-bot-profiles";
function snapshot() { try { return localStorage.getItem(BOT_PROFILES_KEY); } catch { return null; } }
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === BOT_PROFILES_KEY || event.key === null) notify(); };
  window.addEventListener("storage", storage);
  window.addEventListener(changed, notify);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(changed, notify); };
}
function update(change: (current: BotProfileStore) => BotProfileStore) {
  // Re-read before each write so saving a form doesn't discard another tab's Bot or conversation.
  const next = change(parseBotProfiles(localStorage.getItem(BOT_PROFILES_KEY)));
  localStorage.setItem(BOT_PROFILES_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(changed));
}
export function saveBotProfile(bot: BotProfile) { update(current => updateBotProfile(current, bot)); }
export function bindBotConversation(conversationId: string, botId: string) {
  update(current => ({ ...current, conversations: { ...current.conversations, [conversationId]: botId } }));
}
export function forgetBotConversation(conversationId: string) {
  update(current => {
    const conversations = { ...current.conversations };
    delete conversations[conversationId];
    return { ...current, conversations };
  });
}
export function useBotProfiles() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const legacy = useBotAppearances();
  const store = useMemo(() => parseBotProfiles(raw), [raw]);
  const profiles = useMemo(() => resolveBotProfiles(store, legacy), [store, JSON.stringify(legacy)]);
  return { store, profiles };
}
