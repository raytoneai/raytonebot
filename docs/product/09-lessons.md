# 09 踩坑记录

按主题分组。每条：现象 → 原因 → 做法。排障时先搜关键词。

## AgentSphere / E2B

- **`404: method not allowed`** → 装了 e2b SDK 2.x → 用 `e2b<2`（实测 1.11.1）。
- **SDK 连到 e2b.dev / 沙箱连不上** → 没设 `E2B_DOMAIN` → 设为 `agentsphere.run`。
- **停服务后 5188 仍被占用** → 后台命令记录的是外层 shell 的 PID → 启动命令用 `exec`，保证 PID 就是 Node 进程。
- **云域名访问被 Vite 拒绝** → Vite 的 Host 检查在插件之前 → 在 `preview.allowedHosts` 里显式写实例域名。
- **很多 `agentsphere-codesphere-*` 模板不可用** → 构建失败的历史残留 → 先 `GET /templates` 查 ready 状态。

## 沙箱持久化

- **timeout 设 7 天被截断/拒绝** → 平台上限 50 小时 → 用 50 h，到期自动暂停。
- **想给现有沙箱开自动暂停** → 生命周期只能在创建时设置 → 新建沙箱再部署。
- **`autoResume: true` 报 400** → 该字段是对象 → `{"autoPause": true, "autoResume": {"enabled": true}}`。
- **暂停后访问 URL 得到 502** → 平台代理不唤醒 → 本机 `sandbox.py wake`。
- **沙箱在运行，URL 却 502，日志无报错** → 服务用 SDK `background=True` 启动，挂在 SDK 命令会话上，部署脚本退出后被一起清理 → 用 `setsid nohup … &` 完全脱离后启动（`deploy.py` 已改）。先用 `sandbox.py status` 区分「沙箱暂停」与「进程不在」。

## Claude Code / Codex CLI

- **Claude 在模型服务模式下仍请求本机网关** → `~/.claude/settings.json` 的 `env` 段优先于进程环境变量，`--safe-mode` 不跳过它 → 模型服务模式加 `--setting-sources ""`。
- **本机登录模式 401** → 这台机器的「本机登录」就是继承的 `ANTHROPIC_BASE_URL/AUTH_TOKEN` → 本机登录模式不要删除 `ANTHROPIC_*`，只删父会话标记（`CLAUDECODE`、`CLAUDE_CODE_SESSION_ID` 等）。
- **「请求权限」下 `pwd` 没弹审批** → Claude 自动放行它判定为只读的命令 → 通过 `--settings` 给 Bash/Edit/Write 加 `ask` 规则。
- **以为 Codex 不能用 DeepSeek（错误结论）** → Codex 确实只支持 Responses API，但 DeepSeek 原生提供 `/v1/responses` → 用 `-c model_providers.<id>.{base_url,env_key,wire_api="responses"}` 即可，无需登录。下结论前先实测接口，别只凭文档推断。
- **`CODEX_HOME` 指向不存在的目录** → Codex 直接退出 → 先创建目录。
- **只有 Chat Completions 的服务商要跑 Codex** → 需要协议转换网关（如 magpie 的 `serve`），见根目录 `issue.md`。
- **Codex 的顶层 `error` 事件** → 可能只是重连提示 → 只有 `turn.failed` 判失败。
- **改了 `src/pi` 服务端代码不生效** → Vite 不热更新插件里的 Node 模块 → 重启 `npm run dev`。
- **请求总落到 Pi** → HTTP 处理函数逐字段构造输入，新字段要显式转发（曾漏掉 `agentPreset`）。
- **`node --test` 跑不了某些模块** → Node 原生剥类型不支持参数属性，也要求相对 import 带扩展名；可测模块保持只依赖 `.ts` 显式路径。

## 界面

- **设置弹层看不见** → 输入栏 `.composer-tools` 裁切溢出，欢迎页上弹层还会超出视口顶部 → 用 Radix Popover 渲染到 body 并开启碰撞处理。

## 浏览器验收

- **自动化浏览器报 `ERR_BLOCKED_BY_CLIENT`**（Codex 内置浏览器、受控 Chrome）→ 客户端拦截，不是服务问题 → 用本机普通浏览器手动验收；不要为此关闭鉴权或改服务器。
- **双击 `index.html` 白屏** → `file://` 禁止 ES module → 始终用 `npm run dev` / `npm run preview`。

## 事件与界面

- **界面上缺某个状态** → 事件没发对，而不是缺组件 → 查 `piAdapter.ts` 与 `admissionReport.ts`。
- **结构化表单产物显示 `[object Object]`** → 产物渲染映射未处理对象内容 → 待 T2.3 修。
- **`?devtools=1` 里能看到但真实运行看不到** → 差异在适配层，fixture 是理想事件。

## Pi 运行时

- **刷新后会话没了** → 曾是 `SessionManager.inMemory` + 前端 React state，T1.3/T1.4 已修 → 若再出现，检查 `RAYTONEBOT_DATA_DIR`（默认 `~/.raytonebot/data`）是否可写。
- **云端没有可用模型** → 沙箱 `~/.raytonebot/env` 里没有 `DEEPSEEK_API_KEY` → 部署时在本机环境设置该变量再运行 `deploy.py`。
- **Pi 拒绝请求 403** → `requestOrigin.ts` 只放行 loopback；云端靠 `cloud-preview.mjs` 鉴权后把 Host/Origin 标准化为 `127.0.0.1:5188`。不要用 `vite --host 0.0.0.0` 直接暴露。
