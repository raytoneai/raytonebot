import type { AppLocale } from "../locales.ts";
export const controlPlaneCopy: Record<AppLocale, {
  title: string; authorized: string; required: string; expired: string; unavailable: string;
  reopen: string; trustedEntry: string; logout: string; grant: string; revoke: string; scopeRequired: string; settings: string;
}> = {
  en: { title: "Host authorization", authorized: "This page is authorized.", required: "Host authorization is required.", expired: "Host authorization expired.", unavailable: "Host authorization is unavailable.", reopen: "Open a fresh one-time entry from the host to authorize this page. Unconfirmed actions are never resent automatically.", trustedEntry: "Authorize through trusted cloud entry", logout: "Sign out of this host", grant: "Authorize developer access", revoke: "Revoke developer access", scopeRequired: "Developer access is required to view and manage task reviews.", settings: "Open authorization settings" },
  zh: { title: "主机授权", authorized: "当前页面已授权。", required: "当前页面需要主机授权。", expired: "主机授权已过期。", unavailable: "主机授权暂不可用。", reopen: "请从主机重新打开一次性入口来授权本页面。结果未确认的操作不会自动重发。", trustedEntry: "通过可信云入口授权", logout: "退出主机授权", grant: "授权开发者访问", revoke: "撤销开发者访问", scopeRequired: "查看和管理任务复盘需要开发者授权。", settings: "打开授权设置" },
  ja: { title: "ホストの認証", authorized: "このページは認証済みです。", required: "ホストの認証が必要です。", expired: "ホストの認証が期限切れです。", unavailable: "ホストの認証を利用できません。", reopen: "ホストから新しい一回限りの入口を開いて、このページを認証してください。結果が未確認の操作を自動再送することはありません。", trustedEntry: "信頼済みクラウド入口で認証", logout: "ホストからログアウト", grant: "開発者アクセスを許可", revoke: "開発者アクセスを取り消す", scopeRequired: "タスクレビューの表示と管理には開発者アクセスが必要です。", settings: "認証設定を開く" },
};
export function controlPlaneMessage(locale: AppLocale, code?: string) {
  const t = controlPlaneCopy[locale];
  return code === "control_session_expired" ? t.expired : code === "control_auth_unavailable" ? t.unavailable : code === "control_developer_required" ? t.scopeRequired : t.required;
}
