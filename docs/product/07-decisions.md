# 07 架构决策记录（ADR）

格式：编号、日期、状态（已采纳 / 待定 / 已废弃）、决定、理由、何时重新评估。新决定追加在末尾，不改旧条目，废弃时标状态并指向替代条目。

---

### ADR-001 保留 AgentCanvas 导出的 UI，作为自有分叉

- 2026-10-03 · 已采纳
- 决定：现有 React 组件、AgentUX 渲染管线保留并视为自有代码，不再从 AgentCanvas 上游同步。
- 理由：组件已覆盖 Agent 的全部状态（流式、思考、工具、审批、产物、错误、中断），重写没有收益；跟随上游会限制修改。
- 重新评估：需要的交互无法通过事件映射或修现有组件实现时。

### ADR-002 执行运行时使用 Pi，不引入 OpenAgentCore / openbot / CopilotKit

- 2026-10-03 · 已采纳
- 决定：Agent 循环与工具执行使用 `@earendil-works/pi-coding-agent`（MIT），运行在同源 Node 进程内。
- 理由：已接通提交、停止、新会话、模型配置、执行前审批。OpenAgentCore 需要 Go 服务 + PostgreSQL + daemon，其 E2B helper 依赖 SDK 2.x 与 AgentSphere 不兼容，且其原生 Harness 为无人值守执行，不能保留“修改前审批”。openbot 为非商业许可。CopilotKit 模板依赖 Intelligence 平台。详见 `docs/openagentcore-assessment.md`、`docs/nightly-openbot-assessment.md`、`docs/feasibility.md`。
- 重新评估：需要多用户、多引擎、跨实例持久执行或审计时。

### ADR-003 部署在 AgentSphere 沙箱，沙箱视为可丢弃

- 2026-10-03 · 已采纳
- 决定：应用与 Agent 同在一个 AgentSphere 沙箱（`agentmatrix-v1`）中运行；一切状态要能由“部署脚本 + 最近备份”重建。
- 理由：比 VPS/VM 便宜，microVM 隔离 Agent 的 shell；但平台单机、无自愈、有 timeout。
- 重新评估：平台提供持久卷/pause 后，可放宽备份频率。

### ADR-004 会话持久化先用 Pi 自带的文件会话

- 2026-10-03 · 已采纳（T1.3 已实现；实际存储位置见 ADR-012）
- 决定：`SessionManager.inMemory` 改为 `SessionManager.create/open/list`，文件放 `~/.raytonebot/sessions/`；不引入数据库。
- 理由：Pi 0.84.4 已提供，改动集中在 `piHost.ts`；单用户无需查询能力。
- 重新评估：出现任务队列、定时任务、跨会话检索时，考虑 `node:sqlite`（零依赖）。

### ADR-005 单用户 + Basic Auth

- 2026-10-03 · 已采纳
- 决定：公网入口只用 Basic Auth（≥24 字符随机密码）+ 严格 Host/Origin 校验，不做账号系统。
- 理由：首版只有一个用户；Pi 控制器的审批闸门与 cwd 也是单用户设计。
- 重新评估：出现第二个用户之前必须重做身份、会话归属与工作区隔离。

### ADR-006 沙箱内不放 E2B 团队 key

- 2026-10-03 · 已采纳
- 决定：续期、备份、销毁都由本机脚本执行；沙箱内只有访问密码与模型 key。
- 理由：团队 key 可创建任意沙箱，一旦 Agent 工具读到即泄露。
- 后果：本机关机时无法自动续期（见 [06](06-deployment-runbook.md) 续期策略）。

### ADR-007 生产 HTTP 服务暂用 vite preview

- 2026-10-03 · 已采纳
- 决定：沿用 `scripts/cloud-preview.mjs`（Vite preview + Pi 插件 + 鉴权中间件）。
- 理由：已实测可用；`piHost.handle(req, res)` 与框架无关，日后可低成本换成 `node:http`。
- 重新评估：需要自定义路由、更快冷启动或减少生产依赖时。

### ADR-008 默认模型

- 2026-10-03 · 已采纳（测试阶段）
- 决定：默认模型服务 DeepSeek，模型 `deepseek-flash`（DeepSeek-V4.1-Flash），可在设置中切换 `deepseek-v4-pro`。Pi 走 OpenAI 兼容接口，Claude Code 走 `https://api.deepseek.com/anthropic`。
- 更正（2026-10-03）：Codex 只支持 Responses API，但 DeepSeek 原生提供 `/v1/responses`，Codex 可用 DeepSeek key 直接运行、无需登录（已在本机与云端验证）。早先「Codex 不能用 DeepSeek」的判断是错的。

### ADR-009 多引擎：CLI 输出翻译成 Pi 事件

- 2026-10-03 · 已采纳
- 决定：Claude Code、Codex 以 CLI 子进程运行，输出翻译为 Pi 会话事件，复用 `piAdapter` 与现有组件；不引入 Claude Agent SDK、OpenAgentCore 或新的事件协议。
- 理由：零新依赖；Claude 的 stdio `can_use_tool` 已能在执行前审批（TelegramAgent 已验证该协议）；三引擎渲染完全一致。
- 重新评估：需要 Codex 逐步审批时改用 `codex app-server`；需要长驻会话、steering 时评估 Agent SDK。

### ADR-010 沙箱权限模型

- 2026-10-03 · 已采纳
- 决定：按「受保护 / 对外 / 修改 / 只读」分类；工作区内放开，凭据与应用代码在任何模式下都询问；Agent 子进程剥离密钥；云端默认「替我批准」。参考 openbot 的 workspace/full 访问级别与 OpenMuse 的「对外动作需审批」做法，自行实现。
- 重新评估：完成 S1（独立系统用户）后，受保护路径可改为由文件权限硬拒绝。

### ADR-012 持久化：自动暂停沙箱 + 应用数据落盘 + 本机备份

- 2026-10-03 · 已采纳
- 决定：沙箱以 `autoPause` + `autoResume` 创建，超时只暂停（整机快照）；会话数据存 `~/.raytonebot/data`（Pi 文件会话、对话 JSON、CLI 会话 id），不引入数据库；`sandbox.py backup` 拉回本机。
- 理由：平台单次最长 50 小时、无故障自愈、暂停保留期未知；暂停/恢复实测无损且约 1 秒。
- 限制：平台代理不会在访问时自动唤醒，需本机执行 `wake`（E2B key 不进沙箱，ADR-006）。
- 重新评估：平台支持访问即唤醒或持久卷时。

### ADR-011 角色头像

- 2026-10-03 · 已采纳
- 决定：采用 `output/raytone-avatars/animated` 的分层 SVG 与动画，移植到 `src/avatars/`；每个预置角色一个人物；只有最新回答与欢迎页头像运行动画。

### ADR-013 应用自身代码改为只读路径

- 2026-10-03 · 已采纳（修订 ADR-010 中「应用代码受保护」）
- 决定：工作区分离时，应用目录（云端 `/home/user/raytonebot`）从受保护路径移到只读路径：读取、搜索、类型检查、跑测试按普通调用处理；写入/编辑，以及看起来会写入的 bash（重定向、`rm/mv/cp`、`sed -i`、`git checkout`、`npm install/build`、`npx`、`sh -c`、`find -delete` 等）仍为受保护，任何模式都询问。
- 理由：一次规划任务审查应用代码时 48 次调用里询问 35 次，「始终允许」对受保护调用无效，任务无法推进。应用目录不含密钥（env 在 `~/.raytonebot`），需要防的是改写 bot 自身代码与重新构建前端。写入判断是启发式，宁可多问；`sh -c` 等无法判断的一律询问。
- 重新评估：完成 S1（Agent 以独立用户运行、应用目录只读挂载）后，写入改由文件权限硬拒绝，可去掉启发式。
