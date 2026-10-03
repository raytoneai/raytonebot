# 03 路线图与进度

**最快路径**：不换底座，不加后端。保留 AgentCanvas 导出的 UI + Pi 运行时，只补“能用起来”缺的四件事：服务端凭据、会话落盘、工作区分离、部署脚本。前面的调研（OpenAgentCore、openbot、OpenXX）只作为行为参考，不引入代码（见 [07](07-decisions.md)）。

工期按 AI 开发、人只做审批和验收估算；“天”指一个有效工作会话日。

## 里程碑

### M0 接管代码（0.5 天）

目标：项目从“导出物”变成“我们的产品仓库”，AI 有统一说明书。

- [~] T0.1 `git init`，提交当前状态（2026-10-03 首个提交 `eb25439`）；私有远端待定。`.gitignore` 已排除 `.agentsphere/`、`.env*`、`backups/`。
- [x] T0.2 改写 `AGENTS.md`：保留“不新增并行组件、修事件映射”的原则，改为指向本目录；移除“只能改 backendAdapter.ts”这类导出期限制（Pi 路线的主开发区是 `src/pi/`）。
- [~] T0.3 无模型测试：已用 `node --test`（`src/pi/*.test.ts`，未引入 vitest），`npm test` 已进入完成标准；`piAdapter` 事件映射快照仍缺。
- [x] T0.4 `npm run check:local` 与 `node scripts/cloud-preview.mjs --check` 写进 [08](08-acceptance.md)。

验收：`npm run build && npm test && npm run check:local` 全过；仓库有首个提交。

### M1 单用户可用版本（2–3 天）← 最关键

目标：云端 URL 上打开即可完成真实任务，刷新/重启不丢会话。

- [x] T1.1 **服务端模型凭据**：默认 DeepSeek `deepseek-flash`；`deploy.py` 把 `DEEPSEEK_API_KEY` 写入 600 权限的 `~/.raytonebot/env`，启动时加载（云端真实任务已通过）。
- [~] T1.2 **真实模型任务验收**：本机通过（Pi、Claude Code、Codex）；云端 Pi、Claude Code 通过，Codex（DeepSeek key）已能运行，完整 A 组未逐条记录。见 [10](10-agents-and-permissions.md)。
- [x] T1.3 **会话落盘**（2026-10-03）：`SessionManager.inMemory` → `SessionManager.create(cwd, sessionDir)`；`newSession` 新建文件；按 conversationId 找回已有会话。
- [x] T1.4 **会话列表与恢复**（2026-10-03）：`GET /conversations`、`GET /conversations/:id`（历史转成 AgentUX 事件回放）；前端启动时恢复侧栏和当前会话。
- [x] T1.5 **工作区分离**：`RAYTONEBOT_WORKSPACE` / `RAYTONEBOT_WORKSPACE_ROOT`（Pi 与 CLI 引擎共用）；云端为 `/home/user/workspace`，由 T1.13 细分为角色目录。
- [x] T1.8 **多引擎预置角色**：助手 Pi / 规划 Claude Code / 实施 Codex；设置齿轮切换；输入框去掉模型选择。
- [x] T1.9 **沙箱权限模型**：受保护 / 对外 / 修改 / 只读四类；子进程剥离密钥；沙箱默认「替我批准」。
- [x] T1.12 **设置页**：全屏对话框，模型服务可测试连通性、添加预设服务；主题与语言即时切换。
- [x] T1.10 **角色头像**：Codex 的头像动画接入，仅最新一轮回答的头像会动。
- [~] T1.11 **云端部署新代码**：已部署（模板自带两个 CLI）；Codex 用 DeepSeek key 免登录。剩余：验证 `workspace-write` 沙箱在 Firecracker 内是否可用。
- [x] T1.13 **工作区布局**：各角色独立目录 + 共享协作目录，云端已启用。
- [~] T1.6 **部署脚本**：`deploy.py`（构建→上传→`npm ci`→写 env→`setsid nohup` 启动→HTTP 自检）与 `sandbox.py`（create/status/wake/pause/renew/backup/restore）已完成；`kill`（先备份、需 `--yes`）未做。凭据只从本机环境变量读。
- [ ] T1.7 接口前缀 `/__agentcanvas/pi` → `/api/agent`（同时改 client、host、检查脚本）。可选，放在本里程碑末尾。

验收：[08](08-acceptance.md) 中 A、B、C 三组全过；浏览器里人工走一遍核心闭环。

### M2 产物与文件（2 天）

- [ ] T2.1 文件上传到工作区（复用 composer 附件入口 `harness/attachments.ts`）。
- [ ] T2.2 产物/工作区文件下载接口；产物面板可下载。
- [ ] T2.3 修结构化表单产物 `[object Object]`（在 `outputframe/artifactPreview.ts` / `renderKind.tsx` 的映射层修，不新建组件）。
- [ ] T2.4 工作区文件浏览（复用 Output 面板，只读列表）。

### M3 可靠性与运维（2 天）

- [x] T3.1 `backup` / `restore` 脚本（`sandbox.py`）：拉回 `~/.raytonebot/data` + `workspace/` 为带时间戳 tgz；重建后恢复。
- [ ] T3.2 进程重启或沙箱暂停恢复后，未完成的轮次在历史里标记为“已中断”，**不自动重放**（避免重复执行写操作）。
- [ ] T3.3 health 接口（随 T1.7 定前缀）+ 进程守护（沙箱内无 systemd）；部署脚本与 `sandbox.py status` 使用它。
- [ ] T3.4 结构化日志写 `~/.raytonebot/logs/`，`status` 脚本可拉最近日志。
- [x] T3.5 已验证：上限 50 h；pause/resume 无损；创建时可设超时自动暂停；访问不会自动唤醒（见 06、ADR-012）。

### S 安全加固（按 [10](10-agents-and-permissions.md) 已知缺口）

- [ ] S1 Agent 进程用独立非特权系统用户运行；应用目录只读。
- [ ] S2 模型请求走 bot 侧代理，Agent 只持临时 token。
- [ ] S3 出站白名单代理。
- [ ] S4 Codex 改用 `app-server` 以获得逐步审批。

### M4 按需扩展（未排期）

定时任务、IM 入口、多 Agent、多用户鉴权、Git 集成、换执行后端（如 OpenAgentCore）。每项开工前先写需求和 ADR。

## 总工期判断

M0–M3 约 **6–8 个工作会话日**即可覆盖首版“大部分功能”。前提：模型服务商与 key 可用、AgentSphere 行为与 2026-10-03 实测一致。真实模型接入（T1.2）是最大的不确定项，排在 M1 最前面做，暴露问题后再调整计划。

## 待用户决定

| 问题 | 影响 |
| --- | --- |
| ~~默认模型~~：已定 DeepSeek `deepseek-flash`（测试用） | — |
| ~~Codex 云端凭据~~：已用 DeepSeek key 免登录（ADR-008 更正） | — |
| 私有 Git 远端放哪里 | T0.1 |
| ~~续期策略~~：已定自动暂停 + 按需唤醒（ADR-012）；是否加沙箱外的唤醒/续期服务见 `issue.md` #1 | — |

## 进度日志

按时间倒序，每完成一个任务卡追加一行：日期、任务、结果、验证方式。

- 2026-10-03 并行对话：运行中可切换对话、角色、新建对话，其他对话可同时运行（上限 3）。服务端运行状态与审批闸门改为按对话；修复停止请求在 prompt 开始前到达时被忽略的竞态。`piAdapter.ts` 补 `.ts` 扩展名（`piHost.ts` 可被 `node --test` 加载，Vite native-config 警告消失）。验证：新增 `piHost.test.ts`（并行、按对话停止与审批、同对话拒绝、上限、提前停止），`npm test` 22 项、build、`check:local` 通过。未用真实模型做并行的浏览器验收（本机无模型 key）。
- 2026-10-03 侧栏品牌区用 Raytone Bot logo 替换「我的Agent」（深色主题用浅色版）；`deploy.py` 本机未设模型 key 时保留沙箱原有 key（此前会被清空）。部署到 `id705on7k0a1ya1d90icj`（含扩展加固），自检 7 项通过、三个引擎可用；公网 logo 资源 200、bundle 引用正确。浏览器验收：本机 headless Chrome 截图浅色/深色两种主题；云端页面未做视觉验收。
- 2026-10-03 安全加固：Pi 会话不再从 cwd / 全局目录发现扩展、不读项目 `.pi/settings.json`（此前 Agent 写入的扩展会在 bot 进程内执行）。验证：`piResources.test.ts`（默认加载器加载 3 个植入扩展、新配置 0 个且 `AGENTS.md` 仍加载）；本机起独立实例植入扩展后请求 `/state`，旧代码执行、新代码不执行；`npm test` 20 项、`npm run build`、`check:local` 通过。云端未重新部署。
- 2026-10-03 M0：首个提交 `eb25439`（T0.1，远端待定）；改写 `AGENTS.md`（T0.2）；修正文档漂移：02 当前架构/缺口/接口表、03 任务状态、06 实例与脚本一览、01 现状列、08 D 组命令、09 过时条目、`access.json` 文件名。验证：对照 `piHost.ts` 路由、`deploy.py`/`sandbox.py` 参数、`.agentsphere/deployment.json` 与 `package.json` 核对；仅文档改动，未运行构建。
- 2026-10-03 聊天回复 Markdown 渲染（react-markdown + remark-gfm，参照 TelegramAgent）：表格、列表、代码块、引用、任务列表；仅 https 链接可点击，不加载外部图片，不渲染原始 HTML；流式输出时逐步渲染。
- 2026-10-03 聊天区自动跟随到底部（停在底部附近时跟随流式输出；上翻阅读不打扰；发送或切换对话时回到底部），浏览器验证四种情况。
- 2026-10-03 UI/UX 调整：Agent 选择移到侧栏（状态点），设置齿轮移到左下角，顶栏显示当前角色并承载模型来源，对话行带角色头像；修复打开已完成对话时文字重放（仅运行中出现的回复打字），修复欢迎页误高亮历史对话；部署脚本改为 `setsid nohup` 启动，避免部署脚本退出后服务被清理。
- 2026-10-03 Codex 免登录：DeepSeek 原生支持 Responses API，「实施」角色默认用模型服务（DeepSeek key），设置里可切回本机登录；本机与云端（无 Codex 登录）均验证通过。长期存活沙箱不可行（单窗口上限 50 h），记入 `issue.md`。`npm test` 19 项。
- 2026-10-03 持久化（T1.3、T1.4、T3.1、T3.5）：新沙箱 `id705on7k0a1ya1d90icj` 以自动暂停创建并部署。云端验证：记住口令 → backup → pause（URL 502）→ wake（1.2 s，URL 200）→ 仍记得；重新部署重启进程后对话列表与 Pi 上下文仍在。本机验证重启后 Pi 与 Claude Code 都能续接，浏览器刷新后侧栏恢复且自动切回对话角色。`npm test` 18 项。
- 2026-10-03 工作区布局 + 部署（T1.13、T1.6、T1.11）：`deploy.py` 部署到 `i7ngpr2af8dxd2ttcy842`，自检 7 项通过；云端 Pi 与 Claude Code（DeepSeek）真实任务、跨 Agent 交接、规划角色写入限制均通过，浏览器验收通过。修复：长时间无输出时被代理断流（加心跳）、CLI 失败信息改为显示 CLI 自身原因。`npm test` 16 项。Codex 云端未登录。
- 2026-10-03 设置页（T1.12）：齿轮改为全屏设置对话框，分 Agent 角色 / 模型服务 / 权限 / 外观 / 关于五区，参考 magpie 与 CC Switch（MIT，仅借鉴布局与交互，未复制代码）。新增 `POST /provider/test` 真实连通性测试（DeepSeek 实测 98 ms、2 个模型）；`/state` 增加 `sandboxed`、`protectedPaths`、`envKeys`（仅变量名）。主题与默认权限模式存浏览器本地。验证：build、`npm test` 13 项、`check:local` 通过；五个分区、添加服务、主题/语言切换经浏览器截图验收。
- 2026-10-03 多引擎角色 + 权限模型 + 头像完成（T1.8–T1.10）。本机验证：`npm run build`、`npm test`（11 项）、`check:local`、云入口 `--check` 全过；DeepSeek 真实任务、Claude 审批批准/拒绝、Codex 授权批准/拒绝、权限分级、多轮续接均端到端通过；设置面板与头像经浏览器截图验收。云端未部署新代码。
- 2026-10-03 云端实例续期 24 小时，到期 2026-10-04 13:19（北京时间）；续期后页面 HTTP 200。
- 2026-10-03 产品文档建立；确认 Pi 0.84.4 自带文件会话持久化，M1 不需要数据库。
- 2026-10-03 Codex 完成云端部署实验，HTTP/鉴权检查通过（见 `docs/agentsphere-deployment.md`）。
