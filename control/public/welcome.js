// The welcome page (ADR-041): claim, follow provisioning, enter. State comes from GET /api/bot.

const STEPS = [
  ["sandbox", "创建云端电脑", 1],
  ["build", "构建应用", 2],
  ["upload", "上传", 1],
  ["deps", "安装依赖", 4],
  ["browser", "准备浏览器", 4],
  ["configure", "安全隔离与配置", 1],
  ["start", "启动", 1],
  ["verify", "健康检查", 1],
];

const view = document.getElementById("view");
let state = { bot: undefined, error: undefined, busy: undefined, notice: undefined };
let timer;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value; // CSSOM, allowed by the page's CSP
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), { status: response.status });
  return data;
}

const duration = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

function when(at) {
  if (!at) return undefined;
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 86400000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${time}`;
  if (tomorrow) return `明天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time}`;
}

async function refresh() {
  try {
    const data = await api("GET", "/api/bot");
    state = { ...state, bot: data.bot, error: undefined };
  } catch (error) {
    state = { ...state, error };
  }
  render();
  clearTimeout(timer);
  timer = setTimeout(refresh, state.bot?.status === "provisioning" || state.bot?.backingUp ? 1500 : 30000);
}

async function act(name, run) {
  state = { ...state, busy: name, notice: undefined };
  render();
  try {
    await run();
  } catch (error) {
    state = { ...state, notice: error.message };
  }
  state = { ...state, busy: undefined };
  await refresh();
}

const claim = () => act("claim", () => api("POST", "/api/bot/claim", {}));
const retry = () => act("retry", () => api("POST", "/api/bot/retry", {}));
const backup = () => act("backup", () => api("POST", "/api/bot/backup", {}));
const BACKUP_OUTCOME = { completed: "已备份", skipped: "这次没有备份：bot 正在休眠或有任务在运行", failed: undefined };
const setKeepAwake = (event) => act("settings", () => api("POST", "/api/bot/settings", { keepAwake: event.target.checked }));

async function enter() {
  state = { ...state, busy: "enter", notice: undefined };
  render();
  try {
    const { url } = await api("POST", "/api/bot/enter", {});
    location.assign(url);
  } catch (error) {
    state = { ...state, busy: undefined, notice: error.message };
    render();
  }
}

function provisioningView(bot) {
  const now = Date.now();
  const failed = bot.status === "failed";
  const total = STEPS.reduce((sum, [, , weight]) => sum + weight, 0);
  const done = STEPS.reduce((sum, [id, , weight]) => sum + (bot.stages[id]?.endedAt ? weight : 0), 0);
  const items = STEPS.map(([id, label]) => {
    const step = bot.stages[id];
    const current = bot.stage === id;
    const kind = current ? (failed ? "failed" : "current") : step?.endedAt ? "done" : "pending";
    const time = step?.endedAt ? duration(step.endedAt - step.startedAt) : current && !failed ? duration(now - step.startedAt) : "";
    return el("li", { class: kind, "aria-current": current ? "step" : undefined },
      el("span", { class: "mark", "aria-hidden": "true" }), label, el("time", {}, time));
  });
  return [
    el("h1", {}, failed ? "准备中断了" : "正在准备你的 bot"),
    failed
      ? el("p", { class: "error", role: "alert" }, `${STEPS.find(([id]) => id === bot.error?.stage)?.[1] ?? "准备"}失败：${bot.error?.message ?? "未知错误"}`)
      : el("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round((done / total) * 100)) },
        el("span", { style: `width:${Math.max(3, (done / total) * 100)}%` })),
    el("ol", { class: "steps" }, items),
    failed
      ? el("p", {}, el("button", { class: "primary", onclick: retry, disabled: Boolean(state.busy) }, "重试"))
      : el("p", { class: "note" }, "首次准备可能需要十几分钟，可以离开此页，回来时进度还在。"),
  ];
}

function readyView(bot) {
  const running = bot.sandbox?.state === "running";
  const entering = state.busy === "enter";
  return [
    el("h1", {}, "你的 bot 在这里"),
    el("p", { class: "status" }, el("span", { class: `dot${running ? " on" : ""}`, "aria-hidden": "true" }),
      running ? "运行中" : "已休眠，进入时自动唤醒"),
    el("button", { class: "primary", onclick: enter, disabled: Boolean(state.busy) }, entering ? (running ? "正在进入…" : "正在唤醒…") : "进入"),
    state.notice && el("p", { class: "error", role: "alert", style: "margin-top:1.5rem" }, state.notice),
    el("dl", { class: "facts" },
      el("div", {}, el("dt", {}, "下次例行任务"), el("dd", {}, when(bot.nextRoutineAt) ?? (bot.routines ? "48 小时内没有" : "没有开启的任务"))),
      el("div", {}, el("dt", {}, "上次备份"), el("dd", {}, when(bot.lastBackupAt) ?? "还没有备份"),
        bot.backupError && el("dd", { class: "warn" }, `最近一次失败：${bot.backupError.message}`))),
    el("div", { class: "settings" },
      el("label", { class: "toggle" },
        el("input", { type: "checkbox", checked: bot.keepAwake, onchange: setKeepAwake, disabled: Boolean(state.busy) }),
        el("span", { class: "switch", "aria-hidden": "true" }),
        el("span", {}, "保持在线", el("small", {}, "关闭时空闲两小时后休眠，例行任务前自动唤醒。接了 IM 频道需要打开。"))),
      el("p", { style: "margin:0" }, el("button", { class: "quiet", onclick: backup, disabled: Boolean(state.busy) || bot.backingUp },
        bot.backingUp ? "正在备份…" : "立即备份"),
        !bot.backingUp && BACKUP_OUTCOME[bot.lastManualBackup] && el("span", { class: "note", style: "margin-left:0.75rem" }, BACKUP_OUTCOME[bot.lastManualBackup]))),
  ];
}

function render() {
  const { bot, error } = state;
  let content;
  if (error?.status === 401) content = [el("h1", {}, "请先登录 Raytone"), el("p", { class: "lede" }, "登录后回到这里认领你的 bot。")];
  else if (error && bot === undefined) content = [el("h1", {}, "暂时连不上"), el("p", { class: "lede" }, error.message)];
  else if (bot === undefined) content = [];
  else if (bot === null) {
    content = [
      el("h1", {}, "认领你的 Raytone Bot"),
      el("p", { class: "lede" }, "它有自己的云端电脑，关掉页面后也能按计划继续工作。"),
      el("button", { class: "primary", onclick: claim, disabled: Boolean(state.busy) }, state.busy === "claim" ? "正在认领…" : "认领"),
      state.notice && el("p", { class: "error", role: "alert", style: "margin-top:1.5rem" }, state.notice),
    ];
  } else if (bot.status === "ready") content = readyView(bot);
  else content = provisioningView(bot);
  view.replaceChildren(...content.filter(Boolean));
}

refresh();
