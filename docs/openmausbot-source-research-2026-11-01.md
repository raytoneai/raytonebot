# OpenMausBot 源码调研（2026-11-01）

> 调研对象：[milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)。
> 固定版本：默认分支 `main`，提交 `8c663d2b7647dcea04a2278dd0f794f591ae95e0`（2026-10-31）。
> 方法：GitHub connector 读取公开仓库与固定提交源码；只做静态分析，未安装依赖、启动项目或验证发行包。
> 本文是研究依据，建议不自动成为开发任务；RaytoneBot 的取舍见[综合复评](competitive-reassessment-2026-10-29.md)。

## 结论

OpenMausBot 值得学习的核心是：把已有 Bot、技能、例行任务和连接需求封装成可审阅的配置包；用有限 MCP/CLI 入口调度同一主机；按委派任务树判断工作是否真正结束。它并不要求用 Electron、Boat 或 Composio 才能进行本地聊天。[运行说明][launch]、[控制接口][mcpdocs]

必须纠正一个会影响判断的文档偏差：README 宣称导入新 Bot 为 Ask；实际普通文件导入没有写入审批模式，当前本地默认是 Full access。托管公司工作区将默认改为 Ask。技能关闭、例行任务暂停、连接不带凭据是另外几条独立机制，不能合并成“导入默认安全”。[README 声明][askclaim]、[导入实现][import]、[默认模式][approval]、[托管覆盖][hosted]

## 1. 运行链路、持久化与重连

| 观察 | 证据与边界 |
| --- | --- |
| 本地 Node 主机 + Web UI | README 给出 Node 24+、server 与 Vite 两进程，Electron 是额外 shell；npm 命令可启动服务并打开浏览器。这是项目的支持声明，本次未试装。[源码启动][launch]、[npm 启动][npm] |
| 多引擎统一事件 | Claude 使用双向 stream-json、CLI result 结束回合；Codex 使用 app-server JSON-RPC 与 turn/completed；Grok 使用官方 CLI 的 ACP stdio。不是三种引擎共享完全相同的原生协议。[Claude][claude]、[Codex][codex]、[Grok][grok] |
| 主机统一事件出口 | 总线校验 provider、补 providerInstanceId，再合并高频 delta；UI 通过 HTTP 命令和一条 SSE 消费事件。[总线][drivers]、[架构说明][readme] |
| 持久化分层 | 标准事件写入每线程 NDJSON；任务运行记录另有 SQLite store。事件先进入写盘队列再交付监听器，因此不能据此声称“展示前已持久落盘”；队列满时非终态日志可以被丢弃并产生告警。[事件队列][log]、[任务存储][sqlite] |
| SSE 有界重放 | 内存缓冲最多 500 帧、8,000,000 字符；screen/power 不重放旧画面。服务端优先 Last-Event-ID，只有游标覆盖完整且当前可见性允许才重放，缺口返回 resumed=false。[缓冲][replay]、[路由][sse] |

这提供了“原生协议 → 主机事件 → UI”的可参考实现，但内存 SSE 重放、磁盘事件日志、原生 CLI session 恢复是三个层次。不能把短断线续传理解为进程崩溃后的无损执行恢复；本次没有实测客户端缺口重建、跨平台 CLI 兼容或磁盘故障。

## 2. 团队配置包：审阅、去秘密与导入默认

### 格式与审阅

当前主分享格式是 `<team>-<version>.openmaus.json`，支持角色、SKILL.md、playbook、群聊、例行任务、远程 MCP 连接需求等。Markdown 是兼容的 BotMRR 导入入口；不宜把整个能力描述成“团队 Markdown 导出”。[分享文档][sharing]、[解析与升级][parse]

客户端有 `teamImportPreview`，区分 backup、package、legacy team 并构建预览；服务端重新解析并使用文件信任通道。可分享配置与完整备份是不同格式及路径，本报告不把备份恢复行为套到配置包。[预览][preview]、[导入路由][route]

BotMRR Markdown、旧包升级与当前 package 最终进入公共导入逻辑；旧 team manifest 也使用文件导入路径。未发现“Markdown 默认 Ask、JSON 默认 Full”的格式差异。[格式转换][parse]、[路由分支][route]、[公共导入][import]

### 实际默认链

| 项目 | 静态源码确认的行为 |
| --- | --- |
| Bot 权限 | importedMemberProfile 只带角色字段；createBot 不设置 approvalMode；包中的 approval 仅存 suggestedApproval。缺省解析到 Full access，托管工作区启动时覆盖为 Ask。[导入][import]、[创建][create]、[默认][approval]、[托管][hosted] |
| Skills | 普通文件导入经 installSkill，enabled=false；可信组织通道调用 installOrgSkill，enabled=true，代码把管理员审阅视为依据。组织通道是明确例外。[导入分支][import]、[安装默认][skills] |
| Routines | 创建时 enabled=false，超出范围的 timeoutMinutes 会被夹到 5–240 分钟并记录调整。[例行任务][routine] |
| 连接与应用 | Composio=false、connectorTools={}；远程 MCP 用新名称、新记录、空 header 值并关闭，不能因同名继承已有凭据；被组织策略拒绝的连接被列入 skipped。[应用默认][import]、[连接导入][mcpimport] |
| 模型 | 使用安装环境的 defaultSelection；不应用作者机器的模型设置。[导入][import] |
| 记忆 | 支持 starter notes，导入时写 MEMORY.md / topic notes；文档说明分享对话框默认勾选这些笔记，daily logs 不包含。因此“配置包完全不含记忆”不成立。[文档][sharing]、[写入][import] |

Full access 是该产品的审批模式，不能等同于已验证的 OS 隔离能力或任意系统权限。对 RaytoneBot 有价值的是字段白名单、显式审阅、连接重新授权与关闭自动化；不建议复制其本地审批默认。

### 去秘密与失败边界

- 导出分享文档明确排除聊天历史、凭据字段、模型、计算机与访问人群设置；仅携带 SKILL.md，不携带技能脚本。starter notes 中仍可能有人手写的私密信息，必须列入审阅范围。[分享范围][sharing]
- 文本扫描按 secret-shaped 模式替换，并返回被修改的部位；MCP URL 另去 userinfo/fragment、清空查询及 matrix 值，并处理疑似 token。它是启发式清洗，不能证明任意自然语言机密都已移除。[文本清洗][scrub]、[URL 清洗][urls]
- 普通导入是新增记录；catch 会清理本次已创建的 Bot、群、routine、preset、MCP 等。只确认普通抛错回滚，未验证进程在多步写入之间崩溃的原子性。[导入创建][mcpimport]、[清理][rollback]

## 3. 有界 MCP / CLI 控制面及协作完成条件

MCP 通过 stdio 暴露枚举、有限读取、创建/编辑角色、发送工作、等待、打断与切换空闲 Bot 模型等工具。文档明确排除批准请求、记住权限、删数据、导入团队、凭据修改和计算机生命周期；这些是控制面的声明边界，本次未对全部工具做授权穿透测试。[工具范围][mcpdocs]

有直接源码支撑的约束：

- 消息读取 schema 上限 200；返回消息使用字段投影，截图只保留 hasImage，秘密卡仅保留说明与完成状态，不直接返回凭据值字段。[读取 schema][bounded]、[消息投影][projection]
- 文档要求打包桌面的写操作使用配对 session，共享 service loopback 连读取也通常需 session；有 token 时必须显式指定主机/端口，避免探测时误送凭据。这是文档确认的部署约束，未实测每种部署。[配对规则][mcpauth]
- Headless 命令调用同一工具客户接口，doctor 会读取主机 capability、session、可用引擎与 browser 状态；因此 CLI 是现有主机的自动化入口，不是第二套执行引擎。[headless 命令][headless]

最值得参考的是 `wait_for_conversation` 的完成语义：

1. 默认 scope=job，显式 scope=turn 才只等当前对话回合；先检查 task 是否属于指定 Bot/群。[入口][result]
2. 服务端任务视图沿 parentId、reply 与父任务状态计算需要等待的子任务；对话已不 busy，但仍有应等待的工作时仍为 running。子任务等待用户时立即返回 needs-input。[任务判断][job]
3. 使用 since 固定工作范围、version 判断变化；HTTP 请求可挂起，变化或超时后返回，MCP 等待支持 AbortSignal。[等待实现][wait]、[长轮询路由][longpoll]
4. 兼容字段 status=settled 只表示对话结束，不保证工作成功；还要读取 state 与 job。即使主任务 state=completed，reason 仍可能指出子任务 failed/cancelled，不能等同于所有子任务成功。[结果映射][result]、[任务判断][job]

该模型不保证任意后台活动都属于同一 job；源码只聚合其 assignment/reply 规则认定应等待的工作。RaytoneBot 可先明确已有 group_tasks 的完成与部分失败语义，再判断是否需要对外入口；不需要另造团队决策模型。

## 4. 审批、重试和恢复

- 审批不是一套脱离引擎的万能确认层。Codex Full 映射到 never + dangerFullAccess，其余命名模式使用 on-request/workspaceWrite，并校验实际返回的 sandbox 类型；校验失败不开始回合。[Codex 映射][nativeapproval]
- 在经 permission proxy 的路径上，审批服务失联会 deny，并给出让 Agent 解释或在回复中提问的指令；断开连接不会把旧问题交给另一连接的回答。[代理][broker]
- 原生 session 恢复失败按协议状态区分 before-accept / after-accept / unknown；只有证明被拒绝且尚未提交/输出才允许回放。重建 session 会明确告知历史工具结果未带入。[恢复分类][recover]
- Codex 的一个瞬态退出重试门槛是 turn/start 尚未确认、没有 early notifications 且未超过次数，避免已执行工具被自动重复；本次没有将此结论推广为所有驱动的 exactly-once 保证。[重试分支][retry]
- 任务 runtime 重启会重新挂起 needs_input；已发出子任务的运行记录转 waiting；记录到向外动作则失败停止；其余可标记 rerun，但再次中断不无限重跑。保护依赖已记录的证据，不等于外部动作的事务保证。[重启协调][restart]

## 5. 许可、可用范围与借鉴建议

核心为 Apache-2.0；`enterprise/` 是单独的 source-available 许可，生产使用需组织 license key，第三方托管/白标需协议。商标和捆绑第三方组件另有约束，不能以根目录许可证概括整仓。[许可边界][license]、[商标与第三方][trademark]

README 声明本地聊天不需 Boat/Composio key；Boat 提供付费云计算机，Composio 提供连接应用，Electron 提供桌面壳。平台支持矩阵包含 beta 与禁用能力，本文没有验证发行包、远程电脑、OAuth 或托管企业功能。[安装与可选服务][launch]

| 建议 | 适用方式与不宜照搬点 |
| --- | --- |
| 1. 可审阅的团队配置包 | 先定义角色、技能引用、群关系、routine 和连接需求 schema；展示将新增、略过、清洗的内容。复用现有入口，不增独立 Teams 页。[来源][sharing] |
| 2. 分享配置与秘密重新绑定 | 采用字段白名单、新标识与空凭据槽；记忆明确选择并审阅。不要宣传“脱敏后绝对无秘密”，也不复制 Full access 默认。[来源][mcpimport]、[清洗][scrub] |
| 3. 有限外部控制入口 | 有具体脚本/其他 Agent 调度需求时，再把现有主机能力包装为 CLI/MCP；保留分页、取消、鉴权及人在界面审批的边界。[来源][mcpdocs]、[等待][wait] |
| 4. 明确工作完成条件 | 在已有委派记录上区分当前回合结束、子任务仍运行、待用户、部分失败；工具返回结构化证据，不用新 badge 或汇总界面表达。[来源][job]、[结果][result] |
| 5. 按执行证据恢复 | 借鉴“已提交/已输出/已发生向外动作”的重试边界；不要只因没有最终文本而自动重发，或声称断线恢复等于恰好一次执行。[来源][recover]、[重启][restart] |

证据边界：以上“源码确认”仅指固定提交的静态路径；没有运行测试、验证服务授权、测量可靠性或进行全仓安全审计。报告保留 README/实现差异；未核实的发行与服务能力不计为验证通过。

## 固定源码索引

所有链接均固定到同一 SHA，行号按本次读取源码核对。

[readme]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md#L270-L311
[drivers]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/harness/bus.ts#L80-L120
[claude]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/drivers/claude.ts#L1-L22
[codex]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/drivers/codex.ts#L1-L15
[grok]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/drivers/acp/grok.ts#L1-L16
[launch]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md#L343-L401
[npm]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md#L478-L509
[log]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/harness/bus.ts#L152-L178
[sqlite]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/store.ts#L1-L82
[replay]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/host/sse-replay.ts#L1-L57
[sse]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/index.ts#L15011-L15040
[sharing]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/docs/team-sharing.md#L9-L105
[parse]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/shared/package-format.ts#L687-L778
[route]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/routes/teams.ts#L366-L404
[preview]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/src/lib/team-import.ts#L71-L99
[import]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/package-import.ts#L287-L349
[create]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/store.ts#L1324-L1359
[approval]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/shared/approval-mode.ts#L67-L97
[hosted]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/index.ts#L749
[askclaim]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md#L205-L213
[skills]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/skills.ts#L525-L546
[routine]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/package-import.ts#L411-L431
[mcpimport]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/package-import.ts#L239-L281
[scrub]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/shared/package-format.ts#L900-L921
[urls]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/package-export.ts#L352-L433
[rollback]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/package-import.ts#L493-L504
[mcpdocs]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/docs/mcp-server.md#L6-L31
[mcpauth]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/docs/mcp-server.md#L48-L78
[bounded]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/scripts/mcp-server.ts#L156-L200
[projection]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/scripts/mcp-message-projection.ts#L6-L75
[headless]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/headless/commands.ts#L19-L55
[wait]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/scripts/mcp-server.ts#L764-L791
[result]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/scripts/mcp-server.ts#L1058-L1095
[job]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/job-view.ts#L83-L140
[longpoll]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/routes/jobs.ts#L64-L125
[nativeapproval]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/drivers/codex.ts#L278-L319
[broker]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/permission-proxy.ts#L30-L115
[recover]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/resume-recovery.ts#L1-L45
[retry]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/drivers/codex.ts#L1400-L1415
[restart]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/runtime.ts#L77-L123
[license]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/LICENSING.md#L3-L23
[trademark]: https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/LICENSING.md#L41-L49
