import { useSyncExternalStore } from "react";
import { importBotConfig, listBotConfig, putBotConfig } from "../pi/piClient";
import { BOT_STORAGE_KEY, parseBotAppearances } from "./botAppearance";
import { BOT_PROFILES_KEY, legacyBotImport, parseBotProfiles, resolveBotProfiles, type BotProfile, type BotProfileStore, type BotConfigView } from "./botProfiles";

const listeners = new Set<() => void>();
type State = { store: BotProfileStore; profiles: BotProfile[]; revision?: number; error?: string };
let state: State | undefined;
let loading: Promise<void> | undefined;
let imported = false;
let stopWatching: (() => void) | undefined;
function local(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function snapshot(): State {
  if (!state) {
    const store = parseBotProfiles(local(BOT_PROFILES_KEY));
    state = { store, profiles: resolveBotProfiles(store, parseBotAppearances(local(BOT_STORAGE_KEY))) };
  }
  return state;
}
function emit() { for (const notify of listeners) notify(); }
function accept(view: BotConfigView) {
  if (snapshot().revision !== undefined && view.revision < snapshot().revision!) return;
  const store = { conversations: parseBotProfiles(local(BOT_PROFILES_KEY)).conversations, profiles: view.profiles };
  if (snapshot().revision === view.revision && !snapshot().error
    && JSON.stringify(snapshot().store.conversations) === JSON.stringify(store.conversations)) return;
  state = { store, profiles: view.profiles, revision: view.revision };
  // Offline display cache only. Saving and running always require the host.
  try { if (view.revision > 0) localStorage.setItem(BOT_PROFILES_KEY, JSON.stringify({ ...store, source: "server" })); } catch { /* The host saved it. */ }
  emit();
}
export function syncBotProfiles(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const legacy = !imported ? legacyBotImport(local(BOT_PROFILES_KEY), local(BOT_STORAGE_KEY)) : undefined;
      if (legacy) {
        accept(await importBotConfig(legacy.profiles, legacy.conversations));
      } else accept(await listBotConfig());
      imported = true;
    } catch (error) {
      state = { ...snapshot(), error: error instanceof Error ? error.message : String(error) };
      emit();
      throw error;
    } finally { loading = undefined; }
  })();
  return loading;
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  // Every avatar subscribes too: one poller per page, never one per rendered message.
  if (!stopWatching) {
    const load = () => { void syncBotProfiles().catch(() => undefined); };
    const storage = (event: StorageEvent) => { if (event.key === BOT_PROFILES_KEY) load(); };
    window.addEventListener("focus", load);
    window.addEventListener("storage", storage);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 3_000);
    stopWatching = () => { clearInterval(timer); window.removeEventListener("focus", load); window.removeEventListener("storage", storage); };
    load();
  }
  return () => {
    listeners.delete(notify);
    if (!listeners.size) { stopWatching?.(); stopWatching = undefined; }
  };
}
export async function saveBotProfile(bot: BotProfile, revision: number | undefined) {
  if (revision === undefined) throw new Error("Bot 配置尚未加载，请稍后重试。");
  try { accept(await putBotConfig(bot, revision)); }
  catch (error) { void syncBotProfiles().catch(() => undefined); throw error; }
}
function updateBindings(change: (current: Record<string, string>) => Record<string, string>) {
  const current = snapshot();
  const store = { profiles: current.profiles, conversations: change(parseBotProfiles(local(BOT_PROFILES_KEY)).conversations) };
  localStorage.setItem(BOT_PROFILES_KEY, JSON.stringify({ ...store, ...(current.revision !== undefined ? { source: "server" } : {}) }));
  state = { ...current, store };
  emit();
}
export function bindBotConversation(conversationId: string, botId: string) {
  updateBindings(current => ({ ...current, [conversationId]: botId }));
}
export function forgetBotConversation(conversationId: string) {
  updateBindings(current => { const next = { ...current }; delete next[conversationId]; return next; });
}
export function useBotProfiles() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
