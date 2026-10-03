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

- **Claude 子 Agent 的工具全部失败：`Tool permission request failed: AbortError: Stream closed`，连 `echo` 都不行** → 后台子 Agent（`run_in_background`）在主回合 `result` 之后还在跑，而我们在 `result` 时关闭 stdin，它们的权限请求无处可答 → Claude 子进程设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，子 Agent 在前台跑完（同一消息里多个仍可并行）。排查：统计对话里 `tool.call.error` 的 message。

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

## 权限

- **`git -C <应用目录> checkout` / `npm --prefix <应用目录> run build` 绕过审批** → 写命令规则只匹配紧跟可执行文件的子命令 → 识别全局选项后的写子命令，并覆盖 auto、allow-all 和已记住「始终允许」的情况。
- **`git log --grep=reset` 或路径中的 `x` 误触写审批** → 跨任意参数搜索写关键词 → 跳过全局选项及其值，仅匹配子命令；未知全局选项保守处理。
- **任务里一直弹审批，点「始终允许」也没用** → 读取应用自身代码被归为「受保护」，受保护调用在任何模式都问且不受「始终允许」影响；bash 只要命令里出现该路径就算 → 应用目录改为只读路径（ADR-013）：读放行、写仍问。排查方法：拉 `GET /conversations/:id`，统计 `tool.call.awaiting_approval` 的参数。
- **审批卡片参数为空** → Claude 的参数按片段流入，拼到一半时卡片取了旧值 → `requestApproval(id, args)` 用 harness 权限请求里的完整参数。

## 并行运行

- **审批批准到别的对话** → 审批 ID 用毫秒时间戳，同一毫秒的两轮相同；且按顺序找第一个匹配的闸门 → ID 用 `randomUUID()`，前端带 `conversationId` 限定范围。
- **重复提交把原任务停了** → 断线取消在抢到运行槽前就绑定，被拒的请求关闭时也会 abort → 用请求自己的 `AbortSignal`，`runPrompt` 抢到槽后才监听。
- **停止后运行槽一直被占** → `signal` 已取消时再挂 abort 监听不会触发，`wait()` 永远挂起 → 进入等待前先检查 `signal.aborted`。
- **Pi 自动重试或压缩上下文后成功仍显示失败** → `message_end(error)` 先于恢复到达；压缩恢复未必发 `auto_retry_start` → 先暂存错误，重试开始或成功的 `message_end` 时清除，结束时再判定；压缩后仍失败时保留错误。
- **打开历史后马上续问，页面丢消息** → 历史响应与新一轮各自整份替换会话 → 共享一次历史加载，续问先等它；历史只填充仍为空的会话。
- **刷新后打开运行中对话，新进度/审批被旧历史覆盖** → 重接与选中对话各发一次历史请求 → 两者共享加载，屏幕更新拒绝比当前事件更短的快照。
- **点停止后页面已停，服务端还在执行；或重接流再次断开后停止更新** → 本地连接状态被当成任务状态 → 等待停止接口成功才取消订阅；网络失败保持运行并退避重接；明确的 prompt HTTP 拒绝仍显示错误，不被重接吞掉。
- **并发拒绝/请求未到达时消息静默消失** → `/prompt` 已发 200 后才检查运行槽，普通流错误被重接吞掉；mock 409 没覆盖真实路由 → 用真实 HTTP 测试拒绝流中的用户消息与终态；用 `requestId` 核对本次提交，不能用「会话存在」代替。
- **主机永久不可达仍无限运行** → 重连没有次数上限，等待响应没有超时 → 连续 5 次失败后显示状态未确认的错误；对握手、历史请求和缺失心跳设超时，正常心跳不限制任务时长；旧订阅失去控制器所有权后取消待提交帧。
- **重接时最后几段回答丢失** → 读历史与订阅 `/live` 之间任务结束，409 被当作无需处理 → 再读保存历史，只补游标之后的事件。
- **重启后首个 token 前的任务仍悬空** → 没有打开的文本/工具块被误判为任务已结束 → 以 run 终态判断；即使没有开放块，也为未完成的 run 补取消终态。

## 构建与体积

- **按库拆 chunk 后首屏反而变大** → `codeSplitting.groups` 的 `test` 写成宽泛的 `/node_modules/` 会把按需加载的库（mermaid、cytoscape）并进首屏共享 chunk → 只为首屏本来就加载的库建组，并对比「入口 + preload」总量（拆分前后应相等）。React 系（react、react-dom、scheduler）必须同组，分开可能出现两份 React（`useMemo` of null）。
- **改成 `lazy()` 后 chunk 仍在首屏** → 还有别处对该模块的值引用（例如从 `OutputFrame` 取 `normalizeOutputPanelRequest`）→ 改为从其源文件引入；纯 `import type` 不受影响。

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
- **Agent 写的 `.pi/extensions/*.ts` 在 bot 进程里执行** → `createAgentSession` 不传 `resourceLoader` 时用 Pi 默认加载器：SDK 模式默认信任项目，会加载 cwd 与全局目录的扩展，并自动安装 `settings.json` 里的 packages → 用 `createHostResources()`（`noExtensions` + `projectTrusted: false`），见 `piResources.test.ts`。
- **Pi 拒绝请求 403** → `requestOrigin.ts` 只放行 loopback；云端靠 `cloud-preview.mjs` 鉴权后把 Host/Origin 标准化为 `127.0.0.1:5188`。不要用 `vite --host 0.0.0.0` 直接暴露。
