# 10 Agent 角色、引擎与权限

2026-10-04 工作树更新；旧验证记录保留在末尾，新 Linux 隔离与 app-server 的验收见 [08](08-acceptance.md)。生产实例尚未部署本轮变更。

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

- Codex 从 cwd 读取 `AGENTS.md`；云端 Pi 禁止 bot 身份自动读取工作区资源，工作区布局由固定代码生成的说明传入，需要其他说明时通过受限 read 工具读取。本机 Pi 保留自动读取。Claude Code 在 `--safe-mode` 下不读，改由 `--append-system-prompt` 告知同样内容。Claude 用 `--add-dir`，Codex 通过逐项文件/命令审批访问共享目录。
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
| 启动 | `claude -p --output-format stream-json --include-partial-messages --input-format stream-json --permission-prompt-tool stdio --safe-mode --strict-mcp-config --permission-mode manual --settings {ask:[Bash,Edit,Write…]}` | `codex app-server --stdio`，`initialize → thread/start或resume → turn/start` |
| 逐步审批 | 有：`can_use_tool` 控制请求在执行前到达，由 RaytoneBot 审批闸门回答 | 有：`commandExecution/requestApproval` 与 `fileChange/requestApproval`，仅授权当前动作；未知权限类型拒绝 |
| 多轮续接 | `--resume <session_id>` | `thread/resume` 保留原 native thread id |
| 会话丢失 | 尚未输出任何内容时冷启动重试一次 | 同左 |
| 停止 | 进程组 SIGTERM，1.5 s 后 SIGKILL（`src/pi/runtime/process.ts`） | 同左 |
| 本机配置隔离 | `--safe-mode`；模型服务模式下 `--setting-sources ""` | 每轮临时 HOME/CODEX_HOME，不加载用户 config；只链接原生 sessions；本机登录模式单独复制 auth.json，云端禁用登录模式 |

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
- Codex 原生策略固定为 `untrusted` + `read-only`，写动作进入现有审批闸门；安全只读命令可由 Codex 自动执行。`auto` / `allow-all` 由闸门对单次动作作决定，不改为整轮全权限。补丁的每个路径（含重命名目标）都检查，命令按实际 cwd 分类。
- 密钥隔离（`src/pi/runtime/childEnv.ts`）：子进程剥离继承的密钥、E2B 与访问凭据。配置模型服务的任务只拿 bot 模型代理的单轮 token，真实 key 不进入 Agent 环境；Codex 的工具环境进一步仅保留基础变量。云入口读取访问密码后即从进程环境删除。
- 工作区：`RAYTONEBOT_WORKSPACE` 设定 Agent 工作目录；与应用目录不同时，应用代码自动成为受保护路径。
- 「始终允许」按 Agent 记住（`~/.raytonebot/data/approvals.json`），同一 Agent 的新对话、重启后仍有效；不覆盖受保护与对外操作。设置 → 权限里可按 Agent 重置（`POST /approvals/clear`）。
- 进入审批回调的调用三个引擎均经策略拒绝；Codex 原生安全只读调用可以不经过回调。Linux 独立 UID 与文件权限承担硬边界，即使 shell 文本分类没有识别出读凭据行为也不能读 bot env；本机开发不具备这一保证。
- 并行：不同对话可同时运行（上限 3，沙箱 2C/4G）；同一对话同时只有一轮。每个对话一个审批闸门，模式、cwd、「始终允许」互不影响；停止、审批、断开连接只作用于本对话。侧栏 Agent 状态点按角色显示所有在跑的对话（含后台对话等待审批时的「等你确认」）。
- Pi 资源加载（`src/pi/piResources.ts`）：进程内会话不加载任何扩展，项目视为不受信任（忽略 cwd 下的 `.pi/settings.json`、其中的 packages 与 `.pi/extensions`）。沙箱还关闭 AGENTS、skills、prompts、themes 和 SYSTEM/APPEND 文件的自动发现，避免 Agent 把资源链接到 bot 凭据后，由高权限读取器将秘密带入上下文；本机保留这些非扩展资源。需读工作区说明时使用受限工具，不让 bot UID 代读。

### Linux 边界与剩余限制

- `setup_isolation.py` 建立 `raytone-agent` UID，加入 `user` 工作组；workspace 与 Agent home 使用 setgid 目录共享文件，上传文件 0660。应用 root 所有、不可改；`~/.raytonebot` 为 bot 所有且 0700。`sudo -u raytone-agent setpriv --no-new-privs` 启动工具，缺少已安装隔离配置时拒绝沙箱任务。
- Pi 的 7 个工具使用相同 SDK 定义，但 execute 在独立 UID worker 内运行；仅模型循环留在 bot。CLI、Pi worker 原始 stdout 与事件输出都有大小上限。Linux 文件 API 逐级以目录 fd 和 `O_NOFOLLOW` 锚定操作，防止父路径替换指向凭据目录。
- bot 进程内的 gateway 只允许单轮固定 provider/model 路由，禁止转发重定向，token 结束撤销；默认 100 次请求、30 分钟有效期。云端只支持已配置的 HTTPS OpenAI-compatible / Anthropic 服务。本机的其他 Pi 协议、三引擎 HTTP 服务与 CLI 登录模式保持原路径，因此不声称有代理请求次数上限或真实 key 隔离。
- Agent UID 的 IPv4/IPv6 直连、DNS 与 bot HTTP 端口均被防火墙拒绝；仅 loopback gateway 开放。原生 ACL 另拒绝 Agent 遍历 `/run/dbus`、`/run/systemd`，避免借系统 DNS 服务联网；每次启动 Agent 检查 ACL，丢失即拒绝执行。包下载允许 `registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org` 的 CONNECT，校验 TLS ClientHello SNI、公网 IP，拒绝 ECH 与不匹配握手。任意网页访问、其他下载源默认不可用，确有任务需求时再显式扩域。
- 白名单代理不解密 TLS，不是 DLP：不能保证阻止白名单站点上传或站点支持的 HTTP Host 域名前置。三个角色和并行任务仍共享 Agent UID，可以访问彼此的工作区与临时 token；当前范围是单用户 bot 与 Agent 的隔离，不是多租户或逐任务隔离。
- macOS 开发不创建系统用户或防火墙，不具备以上硬边界。生产实例未更新之前仍保留旧架构风险。新 UID/原生会话目录已在两个独立 Linux 测试实例间完成恢复演练，三个引擎续接通过；具体范围见 [08](08-acceptance.md) G 组。

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
