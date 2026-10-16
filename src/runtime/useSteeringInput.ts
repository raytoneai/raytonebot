import { useEffect, useRef, useState } from "react";
import type { ComposerDraft } from "../components/agent-preview/ComposerFrame";
import type { AppLocale } from "../i18n/locales";

export function useSteeringInput(send: ((text: string, requestId: string) => Promise<void>) | undefined,
  updateDraft: (update: (draft: ComposerDraft) => ComposerDraft) => void, locale: AppLocale, scope?: string) {
  const [steering, setSteering] = useState(false);
  const [notice, setNotice] = useState("");
  const request = useRef<{ text: string; id: string } | undefined>(undefined);
  const busy = useRef(false);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => { setNotice(""); request.current = undefined; }, [scope]);
  return { steering, notice, async submit(prompt: string) {
    const text = prompt.trim();
    if (!text || !send || busy.current) return;
    const input = request.current?.text === text ? request.current : { text, id: crypto.randomUUID() };
    request.current = input;
    busy.current = true;
    setSteering(true);
    setNotice("");
    try {
      await send(text, input.id);
      updateDraft(current => current.prompt.trim() === text ? { ...current, prompt: "" } : current);
      request.current = undefined;
      if (currentScope.current === scope) setNotice(locale === "zh" ? "补充已接收，将在下一次模型调用前处理。" : locale === "ja" ? "補足を受信しました。次のモデル呼び出し前に適用します。" : "Received; will apply before the next model call.");
    } catch {
      if (currentScope.current === scope) setNotice(locale === "zh" ? "未确认接收，草稿已保留。可重试或加入队列。" : locale === "ja" ? "受信を確認できません。下書きを保持しました。" : "Receipt unconfirmed. Draft kept; retry or add to queue.");
    } finally { busy.current = false; setSteering(false); }
  } };
}
