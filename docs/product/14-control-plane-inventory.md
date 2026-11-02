# T6.11.0a 控制面入口清单与红灯基线

2026-11-02；源码 HEAD `093309a404b5ec139a0e2b596b665f0389b44a6f`，工作区含尚未提交的 Observer 设计文档。0a 当时仅增加本清单和测试，不改运行时行为；下方入口表保留该历史盘点，0b 当前差异见末节。对应 [方案](13-observer.md#authorization)、[0a/0b](03-roadmap.md#t611-0a)、[OB-00](08-acceptance.md#obs-00)。

**0a 历史安全状态：红灯。** 当时自动回归通过仅说明未授权审核已被稳定复现。0b 已新增会话授权，并将同一测试翻为拒绝未授权；这不等于云部署隔离或 Observer L2 已验收。

## 分类与共同保护

- **H**：公开的最小健康/静态启动内容，不含私有数据或可用管理凭据。
- **R**：用户读取；要求有效用户会话，Observer 内容还须开发者范围。列表、ID、搜索、下载与流均检查，不能仅前端过滤。
- **W**：用户管理写入或用户轮次操作；要求用户会话及 CSRF，保留已有 revision、轮次与资源校验。聊天、停止、文件写入也属于 W，不能从管理写白名单漏掉。
- **A**：绑定轮次/任务的 Agent 能力或专用出站通道；只能使用该能力，不能兑换用户会话或调用 R/W。无需用户 cookie 的例外在各行说明。

下表 `P` 为 `/__agentcanvas/pi`。所有 Pi 路由目前仅共用 `sameOriginRequestAllowed`（[requestOrigin.ts](../../src/pi/requestOrigin.ts)）：无 Origin 直接允许；有 Origin 时校验 loopback Host、hostname 与 port。它不是身份认证；非浏览器客户端能伪造同源 Origin。Vite mount 与 HTTP host 各检查一次，仍未建立用户会话。云入口另有外层 gate，不能据此推断直接本机端口已授权。业务参数、文件路径、revision、runId 校验不是用户授权。

## Node HTTP host：完整现有业务路由

路由依据 [piHttpHost.ts](../../src/pi/piHttpHost.ts) `handle()`（96–679 行），前端 HTTP 调用集中在 [piClient.ts](../../src/pi/piClient.ts)；下面的调用方是其上层功能。当前保护一栏默认包含共同 Origin 检查。除 H 外，本表没有保留匿名访问的目标例外。

| 方法 / 路径模式 | 调用方 | 当前附加保护 / 限制 | 目标分类 / 例外理由 |
| --- | --- | --- | --- |
| OPTIONS `P/*` | 浏览器预检 | Origin；204，无业务正文 | H；仅预检，不建立会话或权限 |
| GET `P/health` | check-local、keeper、部署/服务状态探针 | 无；含 activeRuns、busy、uptime、lastRunAgoMs 等 | H 仅最小健康；活动/运行细节转 R，运维探针须迁移 |
| GET `P/providers` | Settings 模型服务 / useProviderSettings | 脱敏 view，无 key 原值 | R；脱敏配置仍属用户配置 |
| POST `P/providers` | Settings 保存模型配置与密钥 | busy 二次检查、revision、sandbox 隔离检查 | W |
| POST `P/provider/test` | Settings 测试服务 | provider 字段校验；会发出网络请求 | W；不可作为匿名网络代理 |
| GET `P/bots` | useBotConfig、ShellExtras | 配置 view | R |
| POST `P/bots`, `P/bots/import` | Bot 编辑、旧浏览器配置迁移 | schema/revision；import 可迁移历史绑定 | W；import 同样不能匿名写 |
| GET `P/learning` | Settings 开发者 / useLearning | 无独立授权，返回候选与统计 | R |
| POST `P/learning` | useLearning / updateLearning | settings/review/remove schema、revision | W；**已证实匿名可把 pending 改 approved** |
| GET `P/usage` | Settings 用量 | 统计聚合 | R |
| GET `P/skills` | Settings MCP/Skills、Bot 编辑 | view | R |
| POST `P/skills`, `P/skills/remove` | Skills 管理 | schema/revision、刷新工具缓存 | W |
| GET `P/files` (`scope,path,query`) | Output 文件浏览/文档搜索 | workspace scope、路径/链接、privatePaths 排除 | R；文件可读范围不是调用者身份 |
| POST `P/files` (`scope,name`) | Composer 上传 | workspace scope、上传/名称/大小校验 | W |
| GET `P/files/download` (`scope,path`) | Output 下载/预览 | 安全打开文件、privatePaths 排除 | R |
| GET `P/files/download` (`conversationId,artifactId,versionId`) | Output 显式版本下载 | 核对公开产物身份及版本归属 | R |
| HEAD `P/files/download`（上述两种） | 浏览器/下载客户端 | 与 GET 同一安全打开流程 | R；HEAD 不能绕过身份 |
| GET `P/documents` (`scope,path`) | Output 文档编辑器 | workspace/privatePaths、来源查找 | R |
| POST / PUT `P/documents` | Output 新建/保存 | 空闲写窗口、源会话、文件 version、路径验证 | W |
| GET `P/state` (`conversationId?`) | 页面模型/引擎状态 | controller.state | R |
| POST `P/config` | 页面配置与权限模式 | controller.configure 的 schema/忙碌约束 | W；权限配置不能由 Agent 自选 |
| GET `P/channels` | Settings 频道 / useImChannels | 脱敏频道 view | R |
| POST `P/channels/setup` | 聊天连接频道确认卡 | conversationId/requestId/action、pending setup 校验 | W；Agent connect_channel 只能发起，不可替用户确认 |
| POST `P/channels/:platform` (`[a-z]+`) | Settings 频道保存 | 平台白名单、字段过滤、频道服务校验 | W |
| GET `P/routines` | Settings 例行 / useRoutines | 列表 | R |
| POST `P/routines/:id` | Settings 开关/配置 | 服务校验 | W |
| POST `P/routines/:id/run` | Settings 立即运行 | occurrenceId 去重/忙碌/任务状态 | W；会启动轮次 |
| DELETE `P/routines/:id` | Settings 删除 | 服务校验 | W |
| GET `P/browser/state` | Output BrowserView | 浏览器不存在则 404 | R；包含登录候选、页面状态 |
| GET `P/browser/stream` | 可见 Output 的 SSE | watch 生命周期、慢客户端丢帧、断开取消 | R；存续期间也须撤销授权 |
| POST `P/browser/control` | Output 接管/交还/停止/登录/清登录/选标签 | action/登录 URL 白名单、接管互斥 | W；用户操作不可由 Agent 冒名 |
| POST `P/browser/input` | 接管鼠标/键盘 | 有界批次、pageId/controlEpoch 冻结与逐项验证 | W |
| GET `P/memories` | Settings 记忆 / useMemories | 返回 scopes 与 evidence | R |
| POST `P/memories/settings` | Settings 记忆开关 | enabled 验证、工具缓存更新 | W |
| POST `P/memories`, `P/memories/:id` | Settings 新增/修改 | Bot/group scope、expectedText/snapshot 与 evidence 校验 | W；Agent remember/forget 另走 A |
| DELETE `P/memories/:id` | Settings 删除 | memory 服务校验 | W |
| GET `P/mcp` | Settings MCP / useMcpServers | 脱敏列表 | R |
| POST `P/mcp`, `P/mcp/:id` | Settings 新增/修改 | URL/配置、保存与工具刷新 | W；外部 token 不回传 |
| POST `P/mcp/:id/refresh` | Settings MCP 测试/刷新 | 调用远端 MCP、刷新工具 | W |
| DELETE `P/mcp/:id` | Settings 删除 | 删除并刷新工具 | W |
| POST `P/conversations/:id/branch` | MessageActions 分支 | beforeRunId、会话/空闲校验 | W |
| POST `P/steer` | Composer 运行中插话 | conversationId/runId/requestId、长度、禁止斜杠命令 | W；runId 是并发定位，不是授权 |
| POST `P/abort` | Composer stop、runStop | 匹配 active run；兼容省略 runId 的旧调用 | W；保留停止语义，不能给匿名兜底停止入口 |
| GET `P/approval` | 审批卡确认是否仍 pending | toolCallId/conversationId/runId 均必需 | R |
| POST `P/approval` | chatframe/approval、权限决定 | decision、pending 匹配；旧调用可省部分轮次定位 | W；审批不归 A |
| POST `P/input` | 用户问题卡 | conversationId/requestId、pending 与答案校验 | W |
| GET `P/artifacts`, `P/artifacts/versions` | Output 产物列表/搜索/版本 | catalog 范围、分页、身份和文件归属 | R |
| GET `P/conversations` (`query,limit,cursor`) | Sidebar 历史/搜索 | query 长度、分页 | R |
| GET `P/conversations/:id/live` | 页面重接 NDJSON | 需在途运行、游标、断开停订阅；不取消轮次 | R；撤销时断流 |
| GET `P/conversations/:id` (`summary=1?`) | Sidebar / 历史恢复 | ID/存在检查，summary 隐去部分字段 | R；summary 同样私有 |
| DELETE `P/conversations/:id` | Sidebar 删除 | controller 生命周期/存储约束 | W；未来关联派生删除 |
| PATCH `P/conversations/:id` | Sidebar 重命名 | 标题 1–80 字、会话存在 | W |
| POST `P/approvals/clear` | Settings 清 always-allow | agentPreset / gate 范围 | W |
| POST `P/session/new` | 页面重置原生 session | controller 新 session/运行约束 | W |
| POST `P/group/members` | 群成员编辑 | conversationId、members、Bot 身份约束 | W |
| POST `P/group/prompt` | Composer 群消息 | 输入/Bot/权限/文件/运行准入，NDJSON | W；HTTP 主机写来源 web，但目前无用户身份 |
| POST `P/prompt` | Composer 单聊、上传后提交 | 输入/身份/权限/附件/并发校验，NDJSON | W；不能凭请求体声明 authorizedVia |
| GET `P/vault` | Settings Vault / useVault | `x-raytone-vault:1`；sandbox requireAgentIsolation；仅掩码元数据 | R；固定头只是 CSRF 屏障 |
| POST / DELETE `P/vault` | Settings Vault 保存/删除 | 固定头、sandbox 隔离、revision、精确 HTTPS origin | W |
| POST `P/vault/requests/:requestId/answer` | 安全输入/一次性填充审批卡 | 固定头且须 Origin；conversationId/runId、pending 请求；sandbox 隔离 | W；Origin 与已知请求 ID 不能证明用户身份 |

`routines`/`memories`/`mcp` 当前通过 split 取前一两个段；清单列的是语义路由，0b 不能仅用精确路径白名单而让现有可接受的多余段逃过检查。`P` 目前以 startsWith 匹配；统一检查应在分发前执行，未知路径/错误方法仍不得发放凭据。当前未实现 `/observer*`，新增时必须落入 R/W 与开发者范围。

## Vite、provider、云入口与独立 Node 控制服务

| 方法 / 路径模式 | 调用方 | 当前保护 | 目标分类 / 例外理由 |
| --- | --- | --- | --- |
| Vite dev/preview `P/*` | 页面、Pi API 客户端 | [piVitePlugin.ts](../../src/pi/piVitePlugin.ts) mount Origin 后交 host；[vite.config.ts](../../vite.config.ts) 默认 loopback | 按上表 R/W/H；单独挂 host 也须强制检查 |
| Vite 页面、资源、开发 HMR | 浏览器 | 默认 loopback；云上 gate 覆盖全部请求 | H 可允许无会话读取静态启动壳，但绝不能包含管理凭据；dev 任意源码服务不等同于生产公开静态壳 |
| 原 provider proxy | 无当前调用方 | 当前 `vite.config.ts` 无 provider proxy 插件，源码除 requestOrigin 的历史注释外无该入口；不得把 vendor 预览实现当产品入口 | 无存活路由；若恢复须 W 或专用受限 A，不能提供匿名任意 URL 转发 |
| POST 模型测试 / 主机 provider 请求 | Settings 测试、controller/SDK、RSL、群路由/标题 | `/provider/test` 见上表；其他为主机内部调用，无独立 Vite proxy URL | W 测试、A 主机选定配置的运行请求；沿现有 provider store，禁止取得控制面身份 |
| GET `/__raytone/handoff?t=...` | control 欢迎页进入实例 | [cloud-preview](../../scripts/cloud-preview.mjs) 的精确 Host、HMAC/有效期/一次性 token；换 Secure HttpOnly SameSite cookie | 显式凭据交换例外；不是公开 bootstrap；既有云 query handoff 与 0b 本机 fragment 入口区分，不记录 token |
| 云 `* /*`（含静态、Pi 与 OPTIONS） | 浏览器、平台 PreviewProxy | cloud accessGate：Basic 或有效 session；可 opt-in trusted PreviewProxy ingress；精确 Host、Origin/sec-fetch-site、归一化 Host/Origin，删除 Authorization | H/R/W 按下游；0b 从受信任入口带不可伪造内部上下文，剥离外部同名头。现 gate 未向 host 传认证证明 |
| GET `/`, `/favicon.ico`, `/welcome`, `/welcome.js`, `/welcome.css`, `/brand.svg`, `/plex.woff2`（control/server.ts） | 欢迎页 | 静态固定集合，`/` 跳转，favicon 固定响应 | H；不包含实例凭据 |
| GET `/api/bot`（独立 control/server） | 欢迎页 | currentUser + ownedBy；[auth.ts](../../control/auth.ts) 当前仅 CONTROL_DEV_USER 原型，dev 只绑定 loopback | R；不是已完成的真实账号认证，不可当云用户身份依据 |
| POST `/api/bot/claim`, `/api/bot/retry`, `/api/bot/enter`, `/api/bot/settings`, `/api/bot/backup` | 欢迎页 | currentUser、ownership、Origin 严格等于 publicOrigin、JSON、生命周期约束；claim 二次查重 | W；enter 可签发 handoff，真实身份接入单独验证，不能让 Agent 从 loopback 原型领取用户身份 |

云 PreviewProxy 分支依赖“只能通过可信代理访问、外部头被剥离”的网络事实；现代码 opt-in 标记不是身份本身。本批只读盘点并运行云 gate 自检，不验证 AgentSphere/AgentMatrix/VPS 网络部署。

## 内部 Agent 工具桥与专用出站

| 传输 / 方法 / 路径或消息 | 调用方 | 当前保护 | 目标分类 / 例外理由 |
| --- | --- | --- | --- |
| HTTP POST `/model/(v1/)?chat/completions`, `/model/(v1/)?responses` | Pi/Claude/Codex/DSH 子进程 | [modelGateway.ts](../../src/pi/runtime/modelGateway.ts)：随机 Bearer/x-api-key 租约，固定 provider/model/protocol，撤销/超时/请求及正文预算、公共出站、拒绝任意 path/query | A；模型租约仅能调用该模型，不需用户 cookie，不能用租约审核 RSL |
| HTTP POST `/model/(v1/)?messages`, `/model/(v1/)?messages/count_tokens` (`?beta=true` 可选) | Anthropic 协议 CLI | 同上；count_tokens 不扣生成次数 | A；同样不能兑换控制面授权 |
| CONNECT `packageHost:443`（模型网关同端口） | Agent 包下载网络 | 固定 packageHosts、TLS SNI 匹配、DNS 全部地址须 public、预算/超时；此 CONNECT 分支不要求模型租约 | A 专用出站例外；无任意控制面路径，非用户身份，不扩大为通用代理 |
| 进程 stdio Pi tool worker JSON `{name,id,params}` | isolatePiTool | [isolatedPiTools.ts](../../src/pi/runtime/isolatedPiTools.ts)、piToolWorker：父进程传 pipe、剥离 env、Linux UID、取消/输出预算；外层原 Pi gate | A；不额外开 HTTP，不能携带用户控制 cookie |
| Claude stdio control MCP `initialize`, `tools/list`, `tools/call`, `ping` | 本轮 Claude CLI | [cliHarness.ts](../../src/pi/cliHarness.ts) sdkMcpResponse；受控子进程 channel、已装配 tools、各 run/gate 包装。helper 自身不认证 HTTP 用户 | A；发起 remember/forget、browser、connect_channel、create_routine 等保留原工具审批；无用户审核能力 |
| Codex app-server stdio `item/tool/call`、command/file approval、requestUserInput | 本轮 Codex CLI | [codexAppServer.ts](../../src/pi/codexAppServer.ts)：threadId、namespace/工具集合、permission gate、abort/finished；未知请求拒绝 | A；用户回答和权限批准由 host pending gate 接收，不能获得 W |
| DSH Unix socket `host.sock` JSON tool call / context_compacted | DSH host plugin | [dshHarness.ts](../../src/pi/dshHarness.ts)、dshProtocol：临时 socket 0600/隔离组 0660；tool spec + callId/name/args/native session 的单次授权、取消 | A；文件权限和轮次能力，不是管理会话；同 UID 限制保留 |
| Pi SDK 内存工具执行、IM connector→controller、routine clock→controller、群/委派→成员运行 | 主机装配的轮次/后台任务 | piSdkBridge、channelBridge、routines、groupChat：现来源/权限/身份/审批与取消，非 HTTP 入口 | A；来源由 host 定义，不能由模型自报 user_session；自动后台不复用用户凭据 |
| Browser parent/worker IPC request（open/action/input/stream 等） | browserService | [browserService.ts](../../src/pi/browser/browserService.ts) fork 专用 IPC；任务/下载 owner、接管互斥、pageId/epoch；worker 的内部临时 loopback 端口供 Chrome 控制 | A；本机用户操作只能先通过 W，Agent 工具仍走 gate；不是公开管理 API |
| Browser egress proxy 任意 HTTP method `http://public-host/path`；CONNECT `host:80|443` | 受控 Chromium | [egressProxy.ts](../../src/pi/browser/egressProxy.ts)：loopback、公共地址/DNS 全结果与端口检查、固定已核 IP、socket/idle 上限；本地可 opt-in fake IP | A 专用浏览器出站例外；不带用户管理身份，不允许 loopback/private 控制面。不得仅凭浏览器已登录就开放实例管理 |
| 外部 MCP Streamable HTTP `initialize`, `tools/list`, `tools/call` 等 | host mcpServers | 主机保存服务器配置/Bearer，工具范围及审批；非入站 HTTP 管理接口 | A；保存/测试配置仍走 W，MCP Bearer 仅用于远端服务器 |

## 0a 历史红灯证据（翻绿前）

0a 当时运行 `node --test src/pi/observerControlBaseline.test.ts`。该文件现已翻绿；以下记录保留翻绿前的失败基线。测试使用 OS tmpdir 下的新目录，真实 LearningService 从受控 review 回调生成随机 ID 的 pending 候选；不手写候选 JSON。然后销毁 seed service，以相同临时存储启动真实 createPiHttpHost 和 loopback 临时端口。所有数据及 private sibling store 位于临时根下；bridgeFactory 硬拒绝启动引擎，browser/clock 关闭，无用户候选、凭据或模型网络调用。

实际结果（2026-11-02）：1 个自动回归通过，输出明确 `SECURITY RED`。

1. 正确路径 `POST /__agentcanvas/pi/learning`，真实 candidate ID/revision，异源 Origin → 403，磁盘完整对象不变。
2. 无 Origin/Cookie/Authorization GET → 200，能取得候选 ID 与 revision（另一条未授权私有读取）。
3. 无 Origin/Cookie/Authorization POST review approved → 200，磁盘 pending→approved，revision 精确 +1；其余字段不变。
4. 相同旧 revision 重放 → 409，revision 不再变；这是并发控制，不是身份保护。
5. 伪造与 loopback 端口匹配的 Origin 再次审核 → 200，revision 再 +1；读取 host 内存及重新打开 LearningService 的持久状态一致。

不是 404、错误 ID、JSON 验证失败或只看 200。测试故意断言现状不安全；0b 必须把该测试改为无授权时 401/403、候选及 revision 不变，并增加有效会话+CSRF 的成功路径，不能保留该行为作为兼容性承诺。

## 0b 有界实现接点与风险

1. 在 host 分发前建立统一授权检查，并对独立 Vite mount/cloud gate 使用同一可信上下文；路由语义处理前拒绝 R/W，避免 `/memories/:id/extra` 等现有宽匹配绕过。保留现有内容、revision、runId、privatePaths 校验。
2. 本机入口按 [13](13-observer.md#authorization) 由 host 主动交付一次性 fragment，立即清理后 POST 换 HttpOnly 会话；公共 GET/静态壳/错误信息不返回 token。expiry/revoke/restart 与 CSRF 均需测试；不得改为匿名 bootstrap 返回共享 secret。
3. 云 gate 完成认证后传可信内部上下文，外部同名头先剥离。PreviewProxy 的可信边界须各平台验证；目前删除 Authorization、改写 Origin 后，host 没有认证来源证明。不能只添加一个公开固定头。
4. piClient 的 requestJson、手写 fetch（Vault、文件 upload、PATCH/DELETE、prompt/群 prompt）、SSE EventSource 与 download/HEAD 链接都要迁移；HttpOnly cookie 适合同源下载/流，CSRF token 只给有效会话，流须随撤销停止。Settings useLearning、useProviderSettings、useVault 等正常 UI 正例不可省略。
5. check-local、部署 keeper/备份探针、临时脚本现在依赖匿名 API；最小 health 可公开，其余运维用途迁移为明确主机通道，不保留万能 Agent 头。真实 auto Bash/网络/受控浏览器端到端另验，本次 HTTP 测试不等于执行层已阻断。
6. 同 UID 进程仍可能读取主机文件、内存、浏览器或直接篡改 learning/state.json；0b 控制 HTTP 授权并不建立进程隔离或防篡改日志。各云平台 UID、网络、浏览器与入口边界未验时不能启用 L2。

本批验证范围只含源码盘点、独立本机 HTTP/存储红灯与云 gate 自检；未做真实 Agent 命令、真实模型、UI、账号或线上部署验收。


## 0b 当前授权差异与回归（2026-11-02，工作区）

上表“当前保护”指 0a 的 `093309a` 盘点快照，不能据此判断 0b 工作区仍允许匿名请求。生产修改由同批 host/client 负责，本节只同步实际接口与测试证据。

- 原 Pi 前缀的所有业务分发统一要求用户 session；写请求另核 `x-raytonebot-csrf`。`learning` 与新增 `observer*` 读取/写入还需 developer scope。同源 OPTIONS 仅返回无凭据/无私有内容的 204；未知业务路径仍先授权。原内容、revision、pending/runId、文件私有路径校验保留。
- 匿名 GET `/health` 仅 `{status:"ok"}`；session 授权时保留原运行健康字段。经 cloud accessGate 验证的进程内可信上下文仅允许 GET `/health` 与 GET `/routines` 运维读取，审计 reason 为 `cloud_ingress_read`；不签 cookie、不准其他 R/W、不接受外部头冒充此上下文。
- POST `/auth/exchange` 接收本机 `{secret}`，secret 仅由主机对象 `host.controlPlaneAuth.issueEntry(origin)` 签发；Vite 启动主动交付 `#control-plane=...` URL，页面立即清理 fragment 后交换。云入口可用已认证上下文交换。响应设置 HttpOnly cookie，并返回 csrfToken/expiresAt/developerScope；匿名 GET 不下发入口秘密。
- GET `/auth/session` 读有效会话；POST `/auth/developer/grant`、`/auth/developer/revoke`、`/auth/logout` 要求会话和 CSRF。授权来源由 host 填写，不接受 body 的 `requestedBy/authorizedVia`。认证/撤销/过期与流生命周期的专测由 controlPlaneAuth 测试维护。
- HTTP fixtures 经 [controlPlaneTestSupport.ts](../../src/pi/controlPlaneTestSupport.ts) 显式选择 host，执行真实 HTTP exchange；每 fixture 使用自己的 authFetch，不改全局 fetch。只在 learning fixtures 显式 grant developer；跨源/无身份负例保留裸 fetch。慢 body 与 chunked 上传的原回归携带同一真实会话，继续验证业务检查。

翻绿测试仍为 `node --test src/pi/observerControlBaseline.test.ts`，使用真实 LearningService pending 候选与临时磁盘：匿名读取、无 Origin/伪造同源/伪造 cookie/伪造工具桥 Bearer 的 review 均 401，磁盘候选与 revision 不变；真实 modelGateway 签发的租约作为 Bearer 或 x-api-key 也 401。普通 user session 不能读 learning（403）。

同一测试通过真实 host controller → installed Pi SDK → `guardTool` → 原生 bash → curl → 真实 HTTP host 发起 auto 模式 self-review；仅本地模型服务返回受控 OpenAI SSE tool call，未 mock bash、gate、HTTP 或存储。curl 工具结果为 `OB_CONTROL_STATUS=401`，候选/revision 不变；SDK 收到工具结果后第二次模型请求并正常终态，无审批短路。随后经有效 developer session + CSRF 审核成功，磁盘 revision 精确 +1，主机来源为真实 session UUID 而非 body 的 forged-developer，旧 revision 409，重开存储一致。

这验证本机真实 Agent HTTP 路径，不声称阻止同 UID 直接读写文件、已控制浏览器或篡改主机。真实云 Agent UID/网络、PreviewProxy 边界、真实模型价值仍另验；本轮 UI 视觉与受控流程见 [本机记录](../../output/observer-2026-11-02/README.md)；既有 browser egress 回归不能替代云隔离验收。

## Observer 新入口（实现后的补充清单）

| 路径（原 P 前缀） | 能力 | 约束 |
| --- | --- | --- |
| GET `P/observer` | developer 私有读 | 状态、模型标识/预算、finding；不含密钥 |
| POST `P/observer` | developer 管理写 | CSRF、活授权、revision；设置/L1/stop/review/remove/lesson/handoff/无建议终态清理 |
| GET `P/observer/findings/:id?revision=` | developer 私有读 | finding 当前版本、可读来源 |
| GET `P/observer/evidence?findingId=&revision=&evidenceId=` | developer 私有读 | 当前finding引用与可重验快照；临时只读文本 |
| 原 `P/prompt` / stop / conversations / live / summary / artifacts | developer 系统会话能力 | `system:observer` / `observer:` 由主机分支处理；普通搜索/按ID/引用不返回私有内容 |
| `observer_*` 内部查询工具 | L2 本次运行能力 | 固定查询类别、版本/来源/预算/取消；无通用HTTP执行入口 |
| `observer_finding` 内部交接工具 | 单次普通任务的明确授权 | ID、revision、目标Bot、实施范围、TTL/读取次数；不能自批或自动写入 |

云入口、新平台和 sandbox L2 保持拒绝；本机仅已授权开发者能启动。操作在异步准备后及模型请求前重新核对原会话/开发者版本，撤销后再次授予不复活旧操作。
