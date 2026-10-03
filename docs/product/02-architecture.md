# 02 架构

## 当前架构（2026-10-03 实况）

```
浏览器  React UI（AgentCanvas 导出组件 + AgentUX 渲染）
   │  HTTPS + Basic Auth（仅云端）
   ▼
AgentSphere 沙箱 agentmatrix-v1（2C/4G, Linux x86_64, Node 24）
   scripts/cloud-preview.mjs   鉴权、Host/Origin 校验，然后交给 Vite preview
   vite preview + piRuntimePlugin   静态 dist + /__agentcanvas/pi/* 接口
   src/pi/piHost.ts            HTTP 控制器 → 按 agentPreset 分流到 Pi 或 Claude Code / Codex CLI
   @earendil-works/pi-coding-agent  模型循环 + 7 个工具 + 审批闸门
   cwd = /home/user/workspace/agents/<角色>/（RAYTONEBOT_WORKSPACE_ROOT）
   数据 = /home/user/.raytonebot/data/（对话 JSON + Pi 文件会话）
```

本机开发时链路相同，只是 `npm run dev` 监听 `127.0.0.1:5188`，没有 Basic Auth，由 `requestOrigin.ts` 只放行 loopback。

### 请求接口（`src/pi/piClient.ts` ↔ `src/pi/piHost.ts`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/__agentcanvas/pi/state?conversationId=` | 模型、工具、会话信息 |
| POST | `/__agentcanvas/pi/config` | provider/model/thinking/会话 key |
| POST | `/__agentcanvas/pi/prompt` | 发起一轮，返回 NDJSON 事件流；连接断开即中止 |
| POST | `/__agentcanvas/pi/abort` | 停止 `conversationId` 那一轮；不带则停止全部 |
| POST | `/__agentcanvas/pi/approval` | `yes` / `always` / `no`；带 `conversationId` 时只在该对话内匹配；409 = 已失效 |
| POST | `/__agentcanvas/pi/session/new` | 新会话 |
| GET | `/__agentcanvas/pi/conversations` | 对话列表（侧栏恢复） |
| GET / DELETE | `/__agentcanvas/pi/conversations/:id` | 读取历史事件 / 删除对话 |
| POST | `/__agentcanvas/pi/provider/test` | 模型服务连通性测试 |
| POST | `/__agentcanvas/pi/approvals/clear` | 清除某 Agent（`agentPreset`）或全部的「始终允许」 |

### 事件链路

```
Pi 原生事件 → harness/adapters/piAdapter.ts → AgentUX StandardEvent
  → runtime/eventNormalizer + admissionReport → agentmatrix/viewModel → slots/slotRegistry → 组件
```

界面上缺东西时，先查 `piAdapter.ts` 发出的事件和 `admissionReport`，不是加组件。

### 当前缺口

| 缺口 | 位置 | 后果 |
| --- | --- | --- |
2026-10-03 已补：会话落盘与恢复、服务端模型 key（env 文件）、工作区分离、部署/备份脚本。剩余：

| 缺口 | 位置 | 后果 |
| --- | --- | --- |
| 进程重启或沙箱暂停时，运行中的轮次没有标记为中断 | `piHost.ts`、`conversationStore.ts` | 历史里停在半截状态（T3.2） |
| 没有 health 接口与进程守护 | `piHost.ts`、`deploy.py` | Node 崩溃后无人拉起，只能靠 `sandbox.py status` 发现（T3.3） |
| 本机开发未设 `RAYTONEBOT_WORKSPACE(_ROOT)` 时 cwd = 应用目录 | `piVitePlugin.ts` | 本机 Agent 能改/删应用自身 |
| 会话 LRU 上限 12（运行中的不淘汰），并行运行上限 3 | `piHost.ts` | 单用户可接受；多用户前必须重做 |
| Agent 与 bot 同一系统用户 | 部署环境 | 见 [10](10-agents-and-permissions.md) 已知缺口 |

## 多引擎与权限（2026-10-03 新增）

`runPrompt` 按请求里的 `agentPreset` 分流：助手走 Pi，规划走 Claude Code CLI，实施走 Codex CLI。CLI 输出经 `src/pi/cliStreams.ts` 翻译成 Pi 事件，与 Pi 共用 `piAdapter`。审批闸门（`approvalGate.ts`）和权限分类（`permissionPolicy.ts`）三个引擎共用；Agent 子进程统一剥离密钥（`runtime/childEnv.ts`）。`/prompt` 新增字段 `agentPreset`、`claudeCodeModelSource`；`/state` 新增 `harnesses`、`defaultPermissionMode`。细节见 [10-agents-and-permissions.md](10-agents-and-permissions.md)。

| 新模块 | 运行位置 | 作用 |
| --- | --- | --- |
| `src/pi/harnessCatalog.ts` | 浏览器 + Node | 角色、引擎 id、设置存储 |
| `src/pi/cliStreams.ts` | 纯函数 | Claude/Codex 输出 → Pi 事件 |
| `src/pi/cliHarness.ts` | Node | 启动 CLI、stdio 审批、续接、终止 |
| `src/pi/permissionPolicy.ts`、`approvalGate.ts` | Node | 权限分类与审批等待 |
| `src/pi/runtime/process.ts`、`childEnv.ts` | Node | 进程组终止、密钥剥离 |
| `src/avatars/*` | 浏览器 | 角色头像（SVG + 动画），由 `AgentPersonaProvider` 提供 |
| `src/components/settings/*` | 浏览器 | 设置对话框（齿轮打开），文案在 `src/i18n/copy/settings.ts` |
| `src/pi/piResources.ts` | Node | Pi 会话的资源加载：禁用扩展、项目不受信任 |
| `src/pi/providerProbe.ts` | Node | `POST /provider/test`：带密钥请求服务商 `/models`，返回延迟与模型列表 |

## 目标架构（M1–M3 完成后）

```
浏览器（不变的 React UI）
   │ HTTPS + Basic Auth
   ▼
AgentSphere 沙箱
   /home/user/raytonebot/          应用代码 + dist（部署脚本覆盖，受保护路径）
   /home/user/workspace/
       agents/<角色>/              各角色 cwd
       shared/                     协作目录
   /home/user/.raytonebot/
       env                         600 权限：访问密码、模型 API key
       data/conversations/*.json   对话记录
       data/pi-sessions/<对话>/    Pi 文件会话（SessionManager.create / continueRecent）
       pi/                         PI_CODING_AGENT_DIR
       logs/                       待做（T3.4）
   单个 Node 进程：静态文件 + /__agentcanvas/pi/*（T1.7 改名 /api/agent 为可选）

本机 Mac（唯一持有 E2B_API_KEY 的地方）
   scripts/agentsphere/deploy.py   构建 → 上传 → npm ci → 写 env → 启动 → 自检
   scripts/agentsphere/sandbox.py  create / status / wake / pause / renew / backup / restore
   backups/                        拉回 data + workspace 的 tgz
```

要点：

- **持久化用 Pi 自带的文件会话**，不引入数据库（ADR-004、ADR-012）。对话列表与历史经 `GET /conversations`、`GET /conversations/:id` 恢复。只有出现任务队列、定时任务等需求时，才考虑 `node:sqlite`（Node 22.19+ 内置，零依赖）。
- **凭据在服务端**：启动命令 source `~/.raytonebot/env`，模型配置用 `envVar`（默认 `DEEPSEEK_API_KEY`）取 key。浏览器设置面板保留作临时覆盖。
- **工作区分离**：云端用 `RAYTONEBOT_WORKSPACE_ROOT` 生成角色目录（见 [10](10-agents-and-permissions.md)）；本机未设置时 cwd 仍为项目目录。
- **沙箱可丢弃**：重建 = 部署脚本 + 恢复最近备份。沙箱内不放 `E2B_API_KEY`。
- **生产服务器**：M1 继续用 `vite preview` + 插件（已验证可用）。只有当 Vite 成为障碍（启动慢、需要自定义路由）时再换成 `node:http` 独立服务，`piHost.handle(req, res)` 已是框架无关的。

## 目录所有权

| 路径 | 所有权 | 规则 |
| --- | --- | --- |
| `src/pi/**` | 自有，主要开发区 | 服务端能力都在这里加 |
| `src/harness/adapters/piAdapter.ts` | 自有 | 事件映射问题在此修 |
| `src/agent-shell.tsx` | 自有 | 前端状态、会话恢复 |
| `src/exported-project.ts` | 自有 | 品牌、布局、面板、默认模型 |
| `src/components/**`、`src/slots/**` | 自有但冻结 | 只修缺陷，不新增并行组件；`slotRegistry` 必须完整 |
| `vendor/**` | 冻结的第三方构建产物（MIT） | 不改；需要改时按 [04](04-dependency-exit.md) 先迁入 |
| `src/fixtures/**`、`demo-events.ts` | 测试数据 | 只供 `?devtools=1` 和测试 |
| `src/agentmatrix/**`、`src/export/**`、`src/preview-runner/**` | 导出残留 | 不扩展；按 [04](04-dependency-exit.md) 处理 |
| `scripts/**` | 自有 | 检查与部署脚本 |

## 安全边界

- 公网入口唯一保护是 Basic Auth（≥24 字符随机密码）+ 严格 Host/Origin。不要关掉任何一层来“方便调试”。
- 审批是 UX 闸门，不是安全边界；真正的隔离来自 microVM。`auto` 模式的风险命令判断是保守的提示，不是沙箱。
- 浏览器 bundle 里不得出现任何 key；`E2B_API_KEY` 只在本机脚本进程中。
