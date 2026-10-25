import type { AppLocale } from "../locales";

type VaultCopy = {
  nav: string; intro: string; empty: string; loading: string; loadFailed: string;
  add: string; edit: string; newLogin: string; label: string; origin: string; originHint: string;
  username: string; password: string; keepHint: string; enabled: string; disabled: string;
  save: string; saving: string; cancel: string; remove: string; confirmRemove: string;
  refresh: string; failed: string; invalidOrigin: string; draftHint: string; originChangeHint: string;
};

export const vaultCopy: Record<AppLocale, VaultCopy> = {
  zh: {
    nav: "Vault", intro: "保存网站登录信息。每次填入浏览器前，都需要你单独授权。",
    empty: "还没有保存的登录信息。", loading: "正在加载…", loadFailed: "无法加载登录信息，请重试。",
    add: "添加登录信息", edit: "编辑", newLogin: "新的登录信息", label: "名称", origin: "网站地址",
    originHint: "填写完整的 HTTPS 网站源地址，例如 https://example.com，不含路径。",
    username: "用户名", password: "密码", keepHint: "留空保留已保存的值。", enabled: "已启用", disabled: "已停用",
    save: "保存", saving: "正在保存…", cancel: "取消", remove: "删除", confirmRemove: "确认删除",
    refresh: "重新加载", failed: "操作失败，输入已保留，请重试。", invalidOrigin: "请填写不含路径的 HTTPS 网站地址。",
    draftHint: "关闭设置或离开此页会清空未保存的输入。",
    originChangeHint: "更改网站地址需要重新输入用户名和密码。",
  },
  en: {
    nav: "Vault", intro: "Save website logins. Each browser fill requires your separate authorization.",
    empty: "No saved logins yet.", loading: "Loading…", loadFailed: "Could not load logins. Please retry.",
    add: "Add login", edit: "Edit", newLogin: "New login", label: "Name", origin: "Website origin",
    originHint: "Enter the full HTTPS origin, such as https://example.com, without a path.",
    username: "Username", password: "Password", keepHint: "Leave blank to keep the saved value.", enabled: "Enabled", disabled: "Disabled",
    save: "Save", saving: "Saving…", cancel: "Cancel", remove: "Delete", confirmRemove: "Confirm delete",
    refresh: "Reload", failed: "The action failed. Your input is preserved; please retry.", invalidOrigin: "Enter an HTTPS website origin without a path.",
    draftHint: "Closing settings or leaving this page clears unsaved input.",
    originChangeHint: "Changing the website requires entering the username and password again.",
  },
  ja: {
    nav: "Vault", intro: "サイトのログイン情報を保存します。ブラウザーへの入力には、毎回あなたの許可が必要です。",
    empty: "保存されたログイン情報はありません。", loading: "読み込み中…", loadFailed: "ログイン情報を読み込めませんでした。再試行してください。",
    add: "ログイン情報を追加", edit: "編集", newLogin: "新しいログイン情報", label: "名前", origin: "サイトのオリジン",
    originHint: "https://example.com のように、パスを含まない HTTPS オリジンを入力してください。",
    username: "ユーザー名", password: "パスワード", keepHint: "空欄にすると保存済みの値を保持します。", enabled: "有効", disabled: "無効",
    save: "保存", saving: "保存中…", cancel: "キャンセル", remove: "削除", confirmRemove: "削除を確認",
    refresh: "再読み込み", failed: "操作に失敗しました。入力は保持されています。再試行してください。", invalidOrigin: "パスを含まない HTTPS オリジンを入力してください。",
    draftHint: "設定を閉じるか別のページに移動すると、未保存の入力は消去されます。",
    originChangeHint: "サイトを変更するには、ユーザー名とパスワードを再入力してください。",
  },
};
