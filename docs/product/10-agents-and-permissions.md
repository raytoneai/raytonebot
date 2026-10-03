# 10 Agent 角色、引擎与权限

2026-10-03 实现并本机验证。改引擎接入、审批或权限规则前读本文。

## 三个预置角色

界面上的名字：助手 = **Raer**，规划 = **Tonny**，实施 = **Bob**（各语言相同；代码里的角色 id 仍是 `assistant` / `planner` / `builder`）。欢迎语按角色区分，文案在 `src/i18n/copy/composer.ts` 的 `presets.*.greeting`。引擎名旁的小图标在 `src/components/shell/HarnessMark.tsx`（Pi 取自 pi.dev，Claude / OpenAI 取自 Simple Icons，CC0）。

| 角色 | 引擎 | 擅长 | 模型 | 头像 |
| --- | --- | --- | --- | --- |
| 助手（默认） | Pi，进程内 SDK | 日常任务，响应最快 | 设置里的模型服务（当前 DeepSeek `deepseek-flash`） | 圆眼镜女生 |
| 规划 | Claude Code CLI | 读代码、出分步计划；禁用 Edit/Write 类工具 | 模型服务（DeepSeek Anthropic 兼容接口）或本机 Claude 登录 | 方眼镜男士 |
| 实施 | Codex CLI | 改代码、跑命令 | 模型服务（DeepSeek `/v1/responses`，用 API key，**无需登录**）或本机 Codex 登录 | 短发少年 |

- 角色在**侧栏「Agent」区**切换（头像、名称、引擎、状态点：工作中 / 等你确认 / 未安装），保存在浏览器 `localStorage`（`raytonebot.agentSettings`）。点击 Agent 即开始与它的新对话（没有单独的「新建对话」按钮；当前对话为空时直接复用）：上下文存在各引擎自己的会话里，不能跨引擎继承；打开历史对话会切回它的角色。工作中的 Agent 头像外有转动的弧线，等你确认时为静止的琥珀色圆环。
- 顶栏显示当前角色与引擎、模型；点击弹出该角色的模型来源（规划/实施：模型服务或本机登录）。设置（侧栏左下角）只含模型服务、权限、外观、关于。布局参考 OpenDots（侧栏列 Agent、底部设置）与 nightly openbot（状态点，仅借鉴思路）。
- 对话列表每行带角色小头像；输入框占位为「给<角色>发消息…」。
- 输入框不再显示模型选择（`composer.modelSwitcher: false`）；模型在设置的「模型服务」里配置。
- 定义在 `src/pi/harnessCatalog.ts`（浏览器可用）。新增角色 = 在 `AGENT_PRESETS` 加一项 + i18n 文案 + 头像映射（`agent-shell.tsx` 的 `PRESET_AVATARS`）。

## 工作区：各自目录 + 共享目录

设置 `RAYTONEBOT_WORKSPACE_ROOT` 后（云端为 `/home/user/workspace`），由 `src/pi/workspaceLayout.ts` 创建：

| 路径 | 用途 |
| --- | --- |
| `agents/assistant/`、`agents/planner/`、`agents/builder/` | 各角色的工作目录（cwd），各放一份说明布局的 `AGENTS.md`（已存在则不覆盖） |
| `shared/` | 所有角色可读写的协作目录：`plans/`、`handoffs/<from>-to-<to>.md`、`artifacts/`，含 `README.md` |

- Pi 与 Codex 从 cwd 读取 `AGENTS.md`；Claude Code 在 `--safe-mode` 下不读，改由 `--append-system-prompt` 告知同样内容。Claude 与 Codex 通过 `--add-dir` 获得共享目录的访问权限。
- 规划角色只能把文件写进共享目录（其他位置的 Write 直接拒绝，Edit 类工具禁用）。
- 工作区与应用目录分离后，应用代码自动成为受保护路径；每个角色目录与共享目录里的 `.claude/.codex/.agents` 也受保护。
- 未设置时（本机开发）所有角色共用一个目录，行为与之前一致。

## 引擎接入方式

```
Claude Code / Codex 的 JSON 输出
  → src/pi/cliStreams.ts   翻译成 Pi 的会话事件（纯函数，有真实输出录制的测试）
  → harness/adapters/piAdapter.ts   与 Pi 共用同一个事件适配器
  → AgentUX 事件 → 现有组件
```

三个引擎走同一条渲染链路，界面不区分引擎。进程管理在 `src/pi/cliHarness.ts`，控制器分支在 `piHost.ts` 的 `runCliPrompt`。

| 项 | Claude Code | Codex CLI |
| --- | --- | --- |
| 启动 | `claude -p --output-format stream-json --include-partial-messages --input-format stream-json --permission-prompt-tool stdio --safe-mode --strict-mcp-config --permission-mode manual --settings {ask:[Bash,Edit,Write…]}` | `codex exec --json --sandbox … --cd … --ignore-user-config --ignore-rules --disable plugins --disable apps`，prompt 走 stdin |
| 逐步审批 | 有：`can_use_tool` 控制请求在执行前到达，由 RaytoneBot 审批闸门回答 | 无：`exec` 不能逐步询问。「请求权限」下每轮先弹一次写入授权 |
| 多轮续接 | `--resume <session_id>` | `exec … resume <thread_id> -` |
| 会话丢失 | 尚未输出任何内容时冷启动重试一次 | 同左 |
| 停止 | 进程组 SIGTERM，1.5 s 后 SIGKILL（`src/pi/runtime/process.ts`） | 同左 |
| 本机配置隔离 | `--safe-mode`；模型服务模式下 `--setting-sources ""` | `--ignore-user-config` 等；登录（auth.json）保留 |

可执行文件可用 `RAYTONEBOT_CLAUDE_BIN` / `RAYTONEBOT_CODEX_BIN` 指定。`GET /state` 返回 `harnesses`，设置面板据此显示「未安装」。

代码来源：启动参数与 Claude stdio 审批协议参照 TelegramAgent（`backend/src/claudeCodeRuntime.ts`、`codexCliRuntime.ts`），`process.ts` 原样复制；Claude 环境变量加固清单参照 OpenAgentCore（MIT）。nightly openbot（非商业许可）只借鉴设计，未复制代码。

## 权限模型

沙箱 microVM 是主要边界，因此工作区内可以放开；必须守住的是会逃出或活过 VM 的东西。分类在 `src/pi/permissionPolicy.ts`，闸门在 `src/pi/approvalGate.ts`，三个引擎共用。

| 工具调用类别 | 例子 | 请求权限 | 替我批准 | 全部允许 |
| --- | --- | --- | --- | --- |
| 禁止访问 | 读写 `~/.raytonebot`、`~/.ssh`、`~/.aws`、`~/.codex/auth.json`、`~/.claude*` 凭据；`env`/`printenv`/`/proc/*/environ` | **拒绝** | **拒绝** | **拒绝**（不弹询问，工具结果里告知原因） |
| 受保护 | 修改工作区里的 `.claude/.codex/.agents`；**修改**应用自身代码（工作区分离时；含会写入的 bash：重定向、`rm/mv/cp`、`sed -i`、`git checkout`、`npm install/build`、`sh -c` 等） | 询问 | 询问 | **询问**（「始终允许」也不能覆盖） |
| 对外/高危 | `git push`、各类 publish、`docker push`、部署 CLI、`ssh/scp/rsync` 到远端、`curl` 上传、`rm -rf /`/`~`、关机、格式化 | 询问 | 询问 | 直接执行 |
| 修改工作区 | 普通 shell、edit、write、装依赖、联网下载 | 询问 | 直接执行 | 直接执行 |
| 只读 | read/grep/find/ls 等；读取应用自身代码 | 直接执行 | 直接执行 | 直接执行 |

- 默认模式：`RAYTONEBOT_SANDBOX=1`（云端沙箱）时为「替我批准」，本机为「请求权限」。主机通过 `/state` 的 `defaultPermissionMode` 告诉前端；用户手动选择后不再跟随。
- Codex 沙箱：默认 `workspace-write`；只有 `RAYTONEBOT_SANDBOX=1` 且选「全部允许」时用 `danger-full-access`（VM 即边界）。Codex 无法按路径逐条拦截，受保护路径对它只能靠环境变量清理与 Codex 自身沙箱，属于已知缺口。
- 密钥隔离（`src/pi/runtime/childEnv.ts`）：所有 Agent 子进程（Pi bash、Claude、Codex）剥离 `*_API_KEY`、任意 `*_TOKEN`、`*_SECRET(_KEY)`、`*_SECRET_ACCESS_KEY`、`*_PASSWORD`、`*_PRIVATE_KEY`、`*_CREDENTIALS`、`E2B_*`、访问密码；只把各引擎自己需要的那一个重新放回。Codex 执行的命令只看到 `PATH/HOME/LANG` 等基础变量。云入口读取访问密码后即从进程环境删除。
- 工作区：`RAYTONEBOT_WORKSPACE` 设定 Agent 工作目录；与应用目录不同时，应用代码自动成为受保护路径。
- 「始终允许」按 Agent 记住（`~/.raytonebot/data/approvals.json`），同一 Agent 的新对话、重启后仍有效；不覆盖受保护与对外操作。设置 → 权限里可按 Agent 重置（`POST /approvals/clear`）。
- 禁止访问的调用 Pi 与 Claude Code 都在执行前拒绝；Codex 无逐步回调，仍靠子进程剥离密钥与自身沙箱（已知缺口）。
- 并行：不同对话可同时运行（上限 3，沙箱 2C/4G）；同一对话同时只有一轮。每个对话一个审批闸门，模式、cwd、「始终允许」互不影响；停止、审批、断开连接只作用于本对话。侧栏 Agent 状态点按角色显示所有在跑的对话（含后台对话等待审批时的「等你确认」）。
- Pi 资源加载（`src/pi/piResources.ts`）：进程内的 Pi 会话不加载任何扩展，项目视为不受信任（忽略 cwd 下的 `.pi/settings.json`、其中的 packages 与 `.pi/extensions`）。原因：Pi SDK 默认信任项目，并自动安装 settings 里缺失的 packages；Agent 能写自己的 cwd，写入的扩展会在下次建会话时于 bot 进程内执行（2026-10-03 实测复现后修复）。`AGENTS.md` 与 skills 照常加载。要用扩展，须在代码里显式传入，不能靠目录发现。

### 已知缺口（按优先级）

1. **Agent 与 bot 同一个系统用户**：同用户可读 `/proc/<bot>/environ` 和磁盘上的 env 文件。Pi/Claude 的读取会被闸门拦，但 Codex 的命令不经过闸门。下一步：Agent 进程以独立的非特权用户运行，应用目录 root 所有、只读。
2. **模型 key 在 Claude 进程环境里**：Claude 的 Bash 子进程能继承它（`env` 类命令会被拦，但不是硬边界）。下一步：模型请求走 bot 侧代理，Agent 只拿可吊销的临时 token；先用有额度上限的专用 key。
3. **出站网络不受限**：可考虑出站白名单代理（模型代理、包仓库）。
4. **Codex 无逐步审批**：改用 `codex app-server` 的 `requestApproval` 协议可补齐。

## 验证记录（2026-10-03，本机）

| 场景 | 结果 |
| --- | --- |
| 助手（Pi）+ DeepSeek，界面发起 | 通过：工具调用 + 中文回答，头像与角色名正确 |
| 规划（Claude Code）+ DeepSeek，请求权限 | 通过：Bash 每次执行前等待批准；批准执行、拒绝不执行；只读工具直接运行；并行工具调用正确 |
| 规划（Claude Code）+ 本机登录，多轮续接 | 通过：第二轮记得第一轮内容 |
| 实施（Codex），请求权限 | 通过：先弹写入授权；批准后执行，拒绝后整轮取消且不启动 Codex |
| 替我批准 | 通过：`pwd` 直接执行，`ls ~/.ssh` 被拦截 |
| 本机，工作区布局 | 通过：Codex 在 `shared/handoffs/` 写交接文件，Pi 读出内容 |
| 云端（2026-10-03） | 通过：Pi + DeepSeek 在自己目录工作并写交接；Claude Code + DeepSeek 读交接、把计划写进 `shared/plans/`；规划角色写自己目录被拒绝；浏览器验收聊天与设置页。Codex 未登录，返回 401 及登录提示 |
