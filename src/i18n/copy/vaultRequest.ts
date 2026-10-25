import type { AppLocale } from "../locales";
import type { VaultUseResult } from "../../pi/vaultRequestTypes";

type VaultRequestCopy = {
  title: string; question: (origin: string) => string; other: string; save: string;
  hint: string; fill: string; filling: string; failed: string; close: string;
  result: Record<VaultUseResult["status"], string>; saved: string; savedUnconfirmed: string;
};
export const vaultRequestCopy: Record<AppLocale, VaultRequestCopy> = {
  zh: {
    title: "需要登录信息", question: (origin) => `填入 ${origin}`, other: "使用其他账号", save: "保存到 Vault",
    hint: "用户名和密码直接交给主机，不进入聊天或模型上下文。填入后目标网站可以读取；本次只填充，不提交登录。",
    fill: "授权并填充", filling: "正在填充…", failed: "未能确认操作完成，输入已保留。请检查浏览器后重试。", close: "关闭",
    result: { filled: "已填充，请接管浏览器检查并提交登录。", denied: "已取消，本次未授权填充。", expired: "请求已过期，输入已清空。请让 Agent 重新请求。", unavailable: "当前请求已不可用。请接管浏览器检查，或让 Agent 重新请求。", unknown: "无法确认是否已填充，请接管浏览器检查，不要重复填充。" },
    saved: "已保存到 Vault。", savedUnconfirmed: "已保存到 Vault，未确认填充。请接管浏览器检查。",
  },
  en: {
    title: "Login details needed", question: (origin) => `Fill ${origin}`, other: "Use another login", save: "Save to Vault",
    hint: "Your username and password go directly to the host, outside chat and model context. The website can read them once filled. This only fills the fields; it does not submit login.",
    fill: "Authorize and fill", filling: "Filling…", failed: "Could not confirm completion. Your input is preserved. Check the browser before retrying.", close: "Close",
    result: { filled: "Filled. Take over the browser to review and submit login.", denied: "Canceled. This fill was not authorized.", expired: "This request expired and your input was cleared. Ask the Agent to request again.", unavailable: "This request is no longer available. Check the browser or ask the Agent to request again.", unknown: "The fill could not be confirmed. Take over the browser to check; do not repeat the fill." },
    saved: "Saved to Vault.", savedUnconfirmed: "Saved to Vault, but the fill was not confirmed. Take over the browser to check.",
  },
  ja: {
    title: "ログイン情報が必要です", question: (origin) => `${origin} に入力`, other: "別のアカウントを使用", save: "Vault に保存",
    hint: "ユーザー名とパスワードはホストへ直接送られ、チャットやモデルには渡りません。入力後はサイトから読み取れます。今回は入力のみで、ログインは送信しません。",
    fill: "許可して入力", filling: "入力中…", failed: "完了を確認できませんでした。入力は保持されています。ブラウザーを確認してから再試行してください。", close: "閉じる",
    result: { filled: "入力しました。ブラウザーを引き継いで確認し、ログインを送信してください。", denied: "キャンセルしました。今回の入力は許可されていません。", expired: "リクエストの期限が切れ、入力は消去されました。Agent に再度リクエストしてください。", unavailable: "このリクエストは利用できません。ブラウザーを確認するか、Agent に再度リクエストしてください。", unknown: "入力の完了を確認できません。ブラウザーを引き継いで確認し、入力を繰り返さないでください。" },
    saved: "Vault に保存しました。", savedUnconfirmed: "Vault に保存しましたが、入力の完了は未確認です。ブラウザーを引き継いで確認してください。",
  },
};

/** A durable receipt uses fixed product copy, never raw errors or credential fields. */
export function vaultResultMessage(locale: AppLocale, result: VaultUseResult): string {
  const copy = vaultRequestCopy[locale];
  return result.saved && result.status !== "filled" ? copy.savedUnconfirmed
    : [result.saved ? copy.saved : "", copy.result[result.status]].filter(Boolean).join(" ");
}
