import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useLocale } from "../../i18n/LocaleContext";
import { HTML_LANG, type AppLocale } from "../../i18n/locales";
import { USAGE_TOKEN_FIELDS, type UsageRun, type UsageStatus, type UsageTokenField } from "../../pi/usageTypes";
import type { UsageViewState } from "../../runtime/useUsage";
import { useBotNames } from "../shell/ShellExtras";
import { Button } from "../ui";
import "./usage.css";

type Copy = {
  title: string; intro: string; refresh: string; loading: string; empty: string; unavailable: string;
  coverage: Record<UsageRun["coverage"], string>; status: Record<UsageStatus, string>;
  tokens: Record<UsageTokenField, string>; known: string; partial: string; cacheNote: string; loginNote: string;
  requests(count: number): string; recorded(known: number, total: number): string;
  limited: string; more: string; noModel: string; retained: string; history: string;
};
const copy: Record<AppLocale, Copy> = {
  zh: {
    title: "用量", intro: "按任务查看模型服务报告的 token 用量。这里只统计经过当前主机网关的请求，不估算费用。",
    refresh: "刷新", loading: "正在读取用量…", empty: "还没有任务用量记录。完成新任务后可在这里查看。", unavailable: "未提供",
    coverage: { complete: "用量已记录", partial: "部分用量", unknown: "用量不可用" },
    status: { running: "进行中", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断" },
    tokens: { inputTokens: "输入 token", outputTokens: "输出 token", cacheReadTokens: "缓存读取", cacheWriteTokens: "缓存写入" },
    known: "已报告", partial: "仅已记录部分", cacheNote: "输入包含已报告的缓存 token，缓存列为其中的明细。部分记录不代表完整用量或账单。",
    loginNote: "CLI 使用本地登录时，请求可能不经过主机网关，因此用量可能不可用。",
    requests: count => `${count} 次请求`, recorded: (known, total) => `${known} / ${total} 次请求有用量记录`,
    limited: "已达到本任务的请求记录上限", more: "显示更多任务", noModel: "模型未记录", retained: "刷新失败，以下保留上次读取的记录。", history: "最近任务用量",
  },
  en: {
    title: "Usage", intro: "Model-reported tokens by task. Only requests through this host's gateway are included; costs are not estimated.",
    refresh: "Refresh", loading: "Loading usage…", empty: "No task usage yet. New tasks will appear here.", unavailable: "Not reported",
    coverage: { complete: "Usage recorded", partial: "Partial usage", unknown: "Usage unavailable" },
    status: { running: "Running", completed: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted" },
    tokens: { inputTokens: "Input tokens", outputTokens: "Output tokens", cacheReadTokens: "Cache read", cacheWriteTokens: "Cache write" },
    known: "Reported", partial: "Recorded portion only", cacheNote: "Input includes reported cache tokens; the cache columns show that breakdown. Partial records are not complete usage or billing totals.",
    loginNote: "CLI requests using a local login may bypass the host gateway, so their usage may be unavailable.",
    requests: count => `${count} ${count === 1 ? "request" : "requests"}`, recorded: (known, total) => `${known} / ${total} requests reported usage`,
    limited: "This task reached the request history limit", more: "Show more tasks", noModel: "Model not recorded", retained: "Refresh failed. The last loaded records remain below.", history: "Recent task usage",
  },
  ja: {
    title: "使用量", intro: "モデルサービスが報告したタスク別のトークン使用量です。このホストのゲートウェイを経由したリクエストのみを記録し、料金は推計しません。",
    refresh: "更新", loading: "使用量を読み込み中…", empty: "使用量の記録はまだありません。新しいタスクの記録がここに表示されます。", unavailable: "未報告",
    coverage: { complete: "使用量を記録済み", partial: "一部の使用量", unknown: "使用量を取得できません" },
    status: { running: "実行中", completed: "完了", failed: "失敗", cancelled: "停止済み", interrupted: "中断" },
    tokens: { inputTokens: "入力トークン", outputTokens: "出力トークン", cacheReadTokens: "キャッシュ読取", cacheWriteTokens: "キャッシュ書込" },
    known: "報告済み", partial: "記録された分のみ", cacheNote: "入力には報告されたキャッシュトークンを含みます。キャッシュ欄はその内訳です。一部の記録は使用量や請求額の合計を示すものではありません。",
    loginNote: "CLI がローカルログインを使う場合、ホストのゲートウェイを経由せず、使用量を取得できないことがあります。",
    requests: count => `${count} 件のリクエスト`, recorded: (known, total) => `${total} 件中 ${known} 件が使用量を報告`,
    limited: "このタスクのリクエスト記録上限に達しました", more: "さらに表示", noModel: "モデル未記録", retained: "更新に失敗しました。前回の記録を表示しています。", history: "最近のタスク使用量",
  },
};
const harnessNames = { pi: "Pi", "claude-code": "Claude Code", codex: "Codex CLI", dsh: "DeepSeek Harness" };

/** Presentational helper owned by the existing SettingsDialog usage surface. */
export function UsageSection({ usage }: { usage: UsageViewState }) {
  const { locale } = useLocale();
  const c = copy[locale], botNames = useBotNames();
  const [shown, setShown] = useState(25);
  const runs = usage.state?.runs ?? [];
  const number = new Intl.NumberFormat(HTML_LANG[locale]);
  const seconds = new Intl.NumberFormat(HTML_LANG[locale], { style: "unit", unit: "second", maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(HTML_LANG[locale], { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return <section className="settings-usage" aria-label={c.title}>
    <div className="settings-usage-toolbar">
      <p className="settings-intro">{c.intro}</p>
      <Button size="sm" variant="ghost" onClick={usage.refresh}><RefreshCw size={14} aria-hidden="true" />{c.refresh}</Button>
    </div>
    {usage.error ? <p className="settings-status" data-tone="error" role="alert">{usage.error}{usage.state ? ` ${c.retained}` : ""}</p> : null}
    {usage.state?.storageError ? <p className="settings-status" data-tone="error" role="alert">{usage.state.storageError}</p> : null}
    {!usage.state && !usage.error ? <p className="settings-note" role="status">{c.loading}</p> : null}
    {usage.state && !runs.length ? <p className="settings-usage-empty">{c.empty}</p> : null}
    {runs.length ? <ol className="settings-list settings-usage-list" aria-label={c.history}>
      {runs.slice(0, shown).map(run => <li className="settings-usage-run" key={JSON.stringify([run.conversationId, run.runId])}>
        <div className="settings-usage-heading">
          <strong title={run.botId}>{botNames[run.botId] ?? run.botId}</strong>
          <span className="settings-usage-harness">{harnessNames[run.harness]}</span>
          <span className="settings-usage-status">{c.status[run.status]}</span>
          <span className="settings-chip settings-usage-coverage" data-coverage={run.coverage}>{c.coverage[run.coverage]}</span>
        </div>
        <p className="settings-usage-model">{run.model ?? c.noModel}{run.provider ? <span> · {run.provider}</span> : null}</p>
        <div className="settings-usage-meta">
          <time dateTime={new Date(run.startedAt).toISOString()}>{date.format(run.startedAt)}</time>
          {run.endedAt !== undefined ? <span>{seconds.format(Math.max(0, run.endedAt - run.startedAt) / 1000)}</span> : null}
          <span>{c.requests(run.requestCount)}</span>
          {run.coverage !== "complete" ? <span>{c.recorded(run.knownRequestCount, run.requestCount)}</span> : null}
        </div>
        <dl className="settings-usage-tokens">
          {USAGE_TOKEN_FIELDS.map(field => {
            const value = run.totals[field];
            const partial = run.coverage !== "complete" || run.tokenRequests[field] < run.requestCount;
            return <div key={field}>
              <dt>{c.tokens[field]}</dt>
              <dd data-unavailable={value === undefined || undefined}>{value === undefined ? c.unavailable : number.format(value)}</dd>
              {value !== undefined ? <small>{partial ? c.partial : c.known}</small> : null}
            </div>;
          })}
        </dl>
        {run.truncated ? <p className="settings-note">{c.limited}</p> : null}
      </li>)}
    </ol> : null}
    {runs.length > shown ? <Button size="sm" variant="ghost" onClick={() => setShown(value => value + 25)}>{c.more}</Button> : null}
    <div className="settings-usage-notes"><p className="settings-note">{c.cacheNote}</p><p className="settings-note">{c.loginNote}</p></div>
  </section>;
}
