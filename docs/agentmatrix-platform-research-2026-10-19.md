# RaytoneBot 部署 AgentMatrix 可行性评估（2026-10-19）

核查范围：当前 RaytoneBot 工作树、官方文档、官方公开 OpenAPI、npm registry 与实际发布包。仅新增本评估记录；未改应用或依赖，未执行包脚本、创建云资源或读取凭据，未做真实部署验证。下文分开记录工程判断与平台合同。

## 对当前项目的判断

**按用户本轮补充的“AgentMatrix 是自有平台”前提，建议保留 RaytoneBot 现有运行时，先补齐平台宿主能力，再验证迁移。** 当前公开能力仍不足以承诺多数功能无损或完整持久化；但这些缺口应转成可由平台团队实现和验收的项目，不应仅作为外部厂商待答问题。Workspace 的生命周期与授权访问自动唤醒仍是实质改进。

“部署到 AgentMatrix”有两种不同做法，影响差别很大：

| 路线 | 对现有功能的判断 | 当前结论 |
| --- | --- | --- |
| 保留 React + 自有 Node 主机 + Pi/Claude/Codex，仅换 Environment/存储/入口 | 若运行环境满足依赖，聊天、群聊、记忆、MCP、审批、文件与浏览器工具的业务代码大多可沿用 | 最符合低影响目标，但公开 exec、系统权限、生产 ingress 和后台常驻条件尚未成立，不能视为已可部署 |
| 用 SDK 的托管 Session/Agent 取代现有执行主机 | UI 可继续复用，但执行、事件、原生上下文、工具桥、权限和生命周期需适配；Pi 没有对应托管驱动 | 属于运行时迁移，改动和回归范围大，不适合只为解决存储而切换 |

上述是代码与合同的工程推论，不是兼容性实测。平台能力证据见后文；没有据此采用新架构或修改现有 ADR。

## 现有功能与数据对照

当前产品并非纯前端：[`piHost.ts`](../src/pi/piHost.ts) 自己运行引擎、群聊、审批、记忆、MCP、浏览器和例行任务，入口由 [`cloud-preview.mjs`](../scripts/cloud-preview.mjs) 提供鉴权与 Host/Origin 检查。平台托管的 Session 历史不会自动收到这些自有事件或接管这些子进程。

| 功能/状态 | 当前实际位置或机制 | 迁移时必须处理 |
| --- | --- | --- |
| 产品聊天、搜索、分支、Pi 原生上下文、记忆、MCP、例行任务、IM 配置与审批记录 | `/home/user/.raytonebot/data`；`RAYTONEBOT_DATA_DIR` 可配置 | 必须进入受保障的存储，保留仅 bot 可读的权限；不能把它直接变成 Agent 可任意访问的共享文件 |
| 工作文件、附件、产物、角色说明 | `/home/user/workspace`，由 `RAYTONEBOT_WORKSPACE_ROOT` 划分角色与 shared | 对接持久 Workspace，并保持已有绝对路径引用或做可验证的迁移；只复制产物不能保住原生上下文 |
| Claude/Codex 原生会话与 Claude tasks | `/home/raytone-agent/.claude/projects`、`.claude/tasks`、`.codex/sessions`；旧版本可能在 `/home/user` | 与产品记录成套保存；平台自己的 `/agent-state` 不能视为自建 CLI 的自动备份 |
| 浏览器登录状态 | `/home/raytone-browser/profile`；账号提示在 data 内 | 单独纳入持久化，验证 Chromium 数据库、文件锁和权限；只迁工作文件会漏掉它 |
| 操作系统身份与网络隔离 | `raytone-agent` / `raytone-browser` UID、sudo/setpriv、nft、ACL、root 所有 marker | 新机器重新初始化；不能通过关闭沙箱隔离来获得表面兼容 |
| IM、例行任务、后台执行 | 同一 Node 主机中的连接器/计时器；control 外部唤醒和备份 | 自有子进程是否被平台识别为活跃、如何 keep-warm、休眠中如何触发仍需确认 |
| 自建 Bot 名字/头像、聊天归属、草稿、部分模型偏好 | 浏览器 localStorage / IndexedDB；待答草稿为 sessionStorage | 换 origin 后不会自动迁移；云端 Workspace 不能解决这些数据的跨设备同步 |
| 服务凭据与系统依赖 | bot 私有 env、系统安装、CLI/Chromium | 重建时重新注入/安装；不将平台管理 key 放入 bot、Agent 或前端 |

代码依据：[`conversationStore.ts`](../src/pi/conversationStore.ts)、[`piHost.ts`](../src/pi/piHost.ts)、[`cliHarness.ts`](../src/pi/cliHarness.ts)、[`nativeSession.ts`](../src/pi/nativeSession.ts)、[`backup_data.py`](../scripts/agentsphere/backup_data.py)、[`browserService.ts`](../src/pi/browser/browserService.ts)、[`agentProcess.ts`](../src/pi/runtime/agentProcess.ts)、[`setup_isolation.py`](../scripts/agentsphere/setup_isolation.py)、[`botProfiles.ts`](../src/runtime/botProfiles.ts)、[`composerDraftStore.ts`](../src/runtime/composerDraftStore.ts)。

路径迁移不是只加两个环境变量：`agentProcess.ts` 对 `/home/raytone-agent` 有硬校验，备份脚本使用固定路径并拒绝备份根为符号链接，文件/附件和 CLI 历史也可能含绝对路径。若 provider 允许，可评估保留旧路径的挂载；否则需一并改启动、权限、引用与备份恢复。不能未经验证用几个 symlink 代替完整迁移。

## “持久性解决了多少”的判定

| 故障/需求 | 判定 |
| --- | --- |
| 浏览器刷新、应用进程重启 | 现有项目已经有落盘/恢复机制；平台不是首次提供这项能力 |
| 机器删除后工作文件仍在 | 绑定 Workspace 后有明确产品合同，比当前仅依赖整机快照更合适 |
| 机器删除后整个 RaytoneBot 恢复 | 有条件：上表全部必要数据、身份/路径和启动流程必须迁移并验收；原样部署不会自动实现 |
| 网页访问时自动唤醒 | 有明确改进，前提是有效授权预览且 E2B 处于支持的 idle-paused 状态；长期入口另行解决 |
| 没人开网页时 IM/定时任务持续可用 | 未证实，不能用访问自动唤醒推导；平台可能不知道自有 Node 里的轮次与计时器 |
| 宿主损坏、远端存储故障后零丢失 | 没有足够合同/实测证据；本地写入确认不等于远端持久化确认，独立备份仍有必要 |
| 正在执行的任务跨故障继续 | 文件持久化不等于执行恢复；维持项目现有“不自动重放结果不明的动作”语义 |

当前 control 已有实现和本机证据，但未成为已部署的常驻服务；不能沿用旧文档“尚无代码”的描述，也不能把原型实现当作 24×7 保障。依据：[`issue.md`](../issue.md)、[`control/keeper.ts`](../control/keeper.ts)、[ADR-041](product/07-decisions.md)、[部署手册](product/06-deployment-runbook.md)。

## 推荐验证顺序与退出条件

1. **先过部署入口关**：核对平台现有 provider 实现和模板，复用确定性的部署/服务启动能力，并提供必要系统权限和生产入口。若当前只能让托管 Agent 按提示词启动服务，再靠短时预览访问，先补宿主能力，再进入生产迁移试验。
2. **同版本跑现有应用**：保持当前三引擎与默认模型，验证实际 HTTP 入口、流式回复、停止/审批、群聊、MCP/记忆、附件与大文件下载、Chromium 接管及登录。不能只验证静态页能打开。
3. **在独立测试环境做恢复演练**：保存各引擎上下文、分支、文件、配置和浏览器登录；先测进程重启/暂停唤醒，再在明确授权下测删除测试机器后重新绑定同一 Workspace。核对文件摘要、native session ID、旧会话续问、权限与 browser profile；记录实际数据丢失窗口和恢复时间。
4. **单测无人访问场景**：关闭网页，跨越实际 idle/租约窗口，验证 IM 入站与例行任务，以及签名过期后的重新进入；普通业务任务不可因平台误判空闲而暂停。
5. **保留独立备份**：确认存储容量、持久化确认方式、故障恢复及保留策略后，再决定备份周期。已有备份脚本可复用其数据清单与校验原则，但路径、传输和控制接口需要适配。

只有这些条件通过，才能把“多数业务功能可沿用”的推论升级为“多数功能迁移后已验证”。若平台不能提供这些宿主能力，针对当前目标更简单的方向是保留 RaytoneBot 运行时，为其提供常驻 Linux 环境与独立持久盘/备份，无需为了存储问题同时重写 Agent 编排。本轮不选择或采购该替代环境。

验证范围：完成静态代码/官方合同/发布包核查以及本报告链接检查。未修改运行代码，未运行应用测试；未做云端兼容性、存储故障或计费实测。

## Claude 评审复核与自有平台下的最小路线（2026-10-19）

认可“保留 Node 服务、换宿主”的方向。平台归属改变工作分工，不改变已经核对的公开合同，也不等于目前拿到了平台源码或可直接操作生产环境。当前大部分阻碍是平台能力，但 RaytoneBot 的部署适配、数据路径/权限、备份和浏览器 origin 迁移仍属于应用侧工作。

| 必需结果 | 建议的最小实现与验收边界 |
| --- | --- |
| 可重复部署、重启和排错 | 优先由平台内部复用已有 provider/E2B 调用，配合固定版本应用包或模板、幂等 bootstrap、日志及 health。若产品需要通用 exec/upload 再公开租户 API。SDK 不兼容说明现有调用不能直接替换，不意味着必须重写归档校验、隔离安装、恢复和自检等全部脚本。仅增加启动命令还不足以覆盖运行后的部署/故障处理。 |
| 系统依赖与现有隔离兼容 | 管理员预制模板中安装 nft/ACL/Chromium，创建所需 UID，必要时用受控特权初始化。无需先把任意 root 权限交给租户或 Agent。bot/Agent/browser 继续保持当前权限边界。 |
| IM、routines 无人访问时仍可运行 | 在 Environment 层提供明确的常驻/空闲策略和可观测的续租、暂停、恢复行为。监听端口或 health 200 仅代表服务就绪，不能自动当作业务 busy；否则常驻 HTTP 服务会永远“忙”，而挂死进程也可能占着端口。keep-warm 之外还要验证 provider 窗口上限和故障后的启动恢复。 |
| 稳定进入应用 | 提供绑定 Environment/服务的稳定路由和正常用户鉴权；底层短期凭证由服务端刷新，避免把长期签名 bearer URL 当作唯一正式入口。路由生命周期应独立于临时托管 Agent Session，避免归档 Session 影响自有服务。 |
| 全部必要数据随换机恢复 | 先验证受控 bind mount/路径映射能否保留现有绝对路径、UID 和私有目录；这可能比统一改 home 更小。若 provider 不支持，再改可配置路径并更新调用方。多挂载点 API、移除硬校验不是必然前置；仅用符号链接也不能保证现有备份/权限检查通过。 |
| 存储故障边界可验收 | 明确写入何时完成远端持久化、宿主丢失后的恢复来源、独立备份和保留策略；完成正常换机与非正常故障恢复演练。前五项完成仍不能自动推出零数据丢失或在途任务可安全重放。 |

对评审新增事实的核对：

- **配额真实，但不会因新增 UI Bot 立即撞限。** 当前最多 3 个 Workspace/tenant、默认 1 个 Environment/user/tenant；本应用多个具名 Bot 复用既有角色工作区，并不逐 Bot 创建平台资源。只有选择“一部署实例一个卷/环境”并达到对应租户/用户维度时才受限；该拓扑不能先行假设。自有平台可以排配额变更，但当前“3 个不可提额”表示现行套餐/租户配置没有提额入口。[Workspaces](https://agentmatrix.pro/docs/en/workspaces)、[Limits](https://agentmatrix.pro/docs/en/limits)
- **平台 IM 与本应用确为两套架构。** Event Bus 对接独立 Channel Runtime；保留自有 Node 主机时，可以继续现有主动出站 IM 连接器，不必为换宿主同时接 Event Bus。需要保障网络和常驻生命周期。[Event Bus](https://agentmatrix.pro/docs/en/event-bus-and-channel-adapters)
- **同实现双包属官方说明。** `/tmp/amx/package/README.md` 明确 SDK 与 `@astrifer-ai/agent-os` 共用实现和服务合同，但版本序列独立；这不是额外的部署阻碍。[发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz)
- **模板名只是线索。** [`control/server.ts`](../control/server.ts) 默认模板确为 `agentmatrix-v1`，但名称相似不能证明与目标 provider 同镜像。优先核对实际 provider endpoint、解析后的 template ID/构建版本与依赖，不需要先开发一个新模板功能。
- **文档漂移要按影响分级。** 已核实 OpenAPI 有 `preview.am.astrifer.ai` 示例；域名应读取实际 API 响应，不硬编码。OpenAPI 明确当前 E2B 拒绝 wildcard/IPv6 出站选择器，影响实际配置，应优先修正文档并测 preflight。region 示例 `us-east-1` 与当前 Workspace 表单默认 `ap-southeast-1` 不同，不能单凭例子判定服务端允许或拒绝；以实际 provider 选择和校验为准。评审中未具体定位的事件数量差异不直接认定为运行故障。[Platform OpenAPI](https://agentmatrix.pro/openapi/platform-v1.yaml)、[EnvironmentSpecs](https://agentmatrix.pro/docs/en/environment-specs)

与 AgentSphere 当前痛点逐一对照：

| 现有痛点 | AgentMatrix 已有的改善 | 仍需平台工作或验收 |
| --- | --- | --- |
| 暂停后 URL 502，不会自动唤醒 | 有效授权 preview 打开可恢复 idle-paused E2B | 稳定书签入口、凭证刷新、应用 health 与 Host/Origin 衔接 |
| 每次启动/恢复后 50h 封顶，续期可能无效 | independent Environment 提供更高层的生命周期抽象 | 不能因此断言封顶消失；需查实际 provider 租约/续租策略并跨窗口验证 |
| 暂停保留期限未知，实例丢失依赖外部备份 | Workspace 生命周期与机器分离，为迁入的数据提供换机后保留的基础 | 它不等于整机快照永久保留；需迁齐状态，验证远端持久化、保留策略和灾难恢复 |

因此，“只解决了第一条”不完整：Workspace 也改善了第三条的数据与机器绑定问题，但尚不能说整个 RaytoneBot 的持久性已解决。另一个表述修正是：换 origin 后旧 localStorage/IndexedDB 通常仍留在旧 origin，只是新站点不能自动读取，并非一定被删除。

实施优先级建议：先核对现有模板与 provider 控制路径、明确持久化保证；然后打通一个固定应用的启动/常驻/稳定入口；最后迁移应用数据并跑恢复验收。当前目标不要求先做成通用 PaaS，也不新增应用数据库、Channel Runtime 或另一套 Agent 编排。本轮只修订评估，未实施平台功能。

## 平台层结论

**值得做有明确验收条件的小范围 PoC，但公开能力不足以认定它能低改动承载现有完整服务。** 正面能力明确：独立 Environment 可跨 Session 复用；Workspace 生命周期独立于机器；E2B 暂停后，持有效授权预览 URL 访问可自动唤醒。这能改善“机器结束导致工作文件消失”和“休眠后必须手动恢复”的体验。[Environments](https://agentmatrix.pro/docs/en/sandboxes)、[Workspaces](https://agentmatrix.pro/docs/en/workspaces)、[Web previews](https://agentmatrix.pro/docs/en/web-previews)

同时必须拆开三个问题：**文件资产存续、整机状态恢复、后台服务持续运行**。前者有产品合同；后两者不能由 Workspace 或 independent 标签推导。使用其托管 Agent 则是另一条迁移路线，需要适配它的 Session、事件、工具和权限模型，并非仅替换部署 SDK。

## 版本与可复核性

| 项目 | 核查结果 | 官方依据 |
| --- | --- | --- |
| npm latest | `@agentmatrix.pro/sdk@0.11.0` | [registry 元数据](https://registry.npmjs.org/@agentmatrix.pro%2Fsdk) |
| 发布时间 | `2026-10-11T23:56:46.398Z`，北京时间 **2026-10-12 07:56:46** | 同上 `time["0.11.0"]` |
| 发布包合同 | `CONTRACT_VERSION=0.154.0`；包 Changelog 声明要求 Platform `0.154.0`；Node `>=18`、ESM、Apache-2.0 | [官方 0.11.0 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz) 中 `CHANGELOG.md`、`package.json`、`dist/index.d.ts` |
| 当前站点合同 | Production release `release-2026-10-13.1`，Platform OpenAPI `0.155.0`、Admin `0.58.0` | [生产发布清单](https://agentmatrix.pro/meta/release.json) |
| 版本注意 | 包 README 明确 `<=0.9.1` 来自不兼容旧代码库，当前平台拒绝这些旧请求；`0.10.0` 起为当前实现 | 上述发布包 `README.md`、`CHANGELOG.md` |

下载后校验 tarball 的 SHA-1 与 SHA-512，均与 registry 元数据一致。下载的 Platform OpenAPI SHA-256 为 `90d4922402d3f5413aa614fc50d373d6fd4ab251f5eef961ad2f44a4a02677e0`，与生产发布清单相符。npm 页面本身被抓取端返回 403，因此版本判定采用第一方 registry，未把网页不可读当作包不可用。

## 直接作为现有 Node 服务宿主

| 问题 | 明确事实 | 对部署的含义 |
| --- | --- | --- |
| 能否开 Node HTTP 服务 | 标准托管模板有 Ubuntu 22.04、Node 24/npm、Git、Claude/Codex CLI；文档以 Vite/Flask 作为预览示例 | 运行 Node HTTP 服务在能力范围内，但还不是完整的部署控制面。[EnvironmentSpecs](https://agentmatrix.pro/docs/en/environment-specs)、[Web previews](https://agentmatrix.pro/docs/en/web-previews) |
| independent 是否允许无 Agent 机器 | 可以仅指定 EnvironmentSpec 和可选 Workspace 创建，不要求 Session、AgentSpec、模型凭据 | 机器生命周期可以独立；不代表用户取得 provider 原始控制权限。[Environments](https://agentmatrix.pro/docs/en/sandboxes) |
| 原始 exec / 进程 API | `0.11.0` 的 `SandboxesResource` 仅有 `create/list/get/sessions/operation/pause/resume/delete`；公开 Platform 路由没有对应原始 exec、进程管理或 SSH 接口 | 现有 `commands.run`/进程启动/健康检查流程没有公开的一一替代。文档所示执行入口是托管 Agent 的原生 shell 工具；也可能由运营方提供额外能力，但不能假设存在。[SDK 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz)、[Platform OpenAPI](https://agentmatrix.pro/openapi/platform-v1.yaml) |
| 自定义镜像 | E2B 模板由 provider 管理员配置；SDK 的旧 `template_id` 被忽略。新 container 配置拒绝用户传入 `image/control_port` | 无法仅用租户 SDK 指定现有完整系统镜像；自定义模板需要运营方支持。[SDK 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz) |
| 特权/系统依赖 | 官方标准工具清单没有承诺 sudo、创建 OS 用户、nft、ACL、独立浏览器用户或 Chromium 的可用性；工具安装还受出站网络控制 | 这些项目必须实机探测；“Linux sandbox”不足以证明现有隔离方案兼容。[EnvironmentSpecs](https://agentmatrix.pro/docs/en/environment-specs) |
| 端口、SSE、WebSocket | 允许的 HTTP 端口可走 PreviewProxy；支持流式响应和 WebSocket；内部 HTTP、外部 TLS | HTTP/SSE/WS 协议本身不是主要阻断点。[Web previews](https://agentmatrix.pro/docs/en/web-previews) |
| 稳定生产入口 | 预览按 Session/端口签发，URL 短期有效、可刷新和撤销；官方明确其用途是给人查看开发中的网页，不是生产 ingress | 不能把预览 URL 直接当永久域名、机器人 webhook 或稳定机器调用地址。[EnvironmentSpecs](https://agentmatrix.pro/docs/en/environment-specs) |

原始 exec 的缺失是**已检查的公开 SDK/HTTP 合同缺口**，不是断言物理机器无法执行命令，也不是断言厂商绝不提供私有能力。通过“发消息让托管 Agent 启动服务”能做演示，却不能自动视为确定性的部署和故障恢复接口。

## 持久化的实际边界

| 项目 | 证据等级与结果 |
| --- | --- |
| 持久化根 | **明确**：Workspace 项目树挂载到 `/workspace`；创建 Environment 时不绑定 Workspace 则是本地临时存储，没有持久化保证。绑定在创建时固定。[Workspaces](https://agentmatrix.pro/docs/en/workspaces) |
| 删除机器或结束 Session | **明确**：Workspace 保留；删除 Workspace 是另一个显式、受权限控制的操作。仍有 Environment/checkpoint 引用时拒绝删除。[Workspaces](https://agentmatrix.pro/docs/en/workspaces) |
| Agent 原生历史 | **明确**：平台的 Session 私有状态在 `/agent-state/sessions/<session_id>/`，不由 Workspace 文件 API 暴露；SDK 的 Environment delete 注释说明保留 Workspace 及其私有 Agent 状态。此机制不等于自动备份自建应用的任意 home 目录。[Workspaces](https://agentmatrix.pro/docs/en/workspaces)、[SDK 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz) |
| 文件 API | **明确**：按 Volume ID 操作文件，单文件上限 1 MiB，无递归打包下载，不跟随符号链接。这是公开文件接口限制，不能解释成 guest 文件系统每个文件最大 1 MiB。[Workspaces](https://agentmatrix.pro/docs/en/workspaces) |
| 写入确认 | **明确**：文件变更成功仅确认检查过文件系统同步后的本地视图发布；没有统一的远端持久化保证。不能把一次 HTTP 204 当作零丢失备份证明。[Platform OpenAPI](https://agentmatrix.pro/openapi/platform-v1.yaml)，`replaceWorkspaceFile` 等 mutation response |
| 底层与 checkpoint | **有限证据**：OpenAPI 删除说明提到 JuiceFS Trash；公开 references 有 `has_checkpoint`。未发现公开强制 flush、checkpoint create/restore、存储复制状态或 RPO 查询接口。不能据这些字段断言具体对象存储拓扑或同步周期。[Platform OpenAPI](https://agentmatrix.pro/openapi/platform-v1.yaml) |
| home / 根盘 / 浏览器 profile | **尚无证据**：Workspace 合同没有把任意 `/home`、系统安装、OS 用户、浏览器 profile 或全部进程状态纳入“更换物理机器后仍保留”的保证。需要把应用数据迁入受保障路径并验证，或做独立备份/恢复。 |
| 数量、容量、保留期 | **明确数量**：每 tenant 最多 3 个 Workspace，所有 namespace 合计，不能通过套餐或 tenant 配置上调。[Limits](https://agentmatrix.pro/docs/en/limits) **未确认**：托管 Workspace 的总字节容量、inode 上限、远端刷盘延迟、历史版本/快照保留期、底层宿主丢失后的 RPO/RTO、账户过期后的保留政策。附件/Skill 的配额不能代替 Workspace 总容量。[Volume API](https://agentmatrix.pro/docs/en/api-volume) |

## 休眠、超时、常驻能力

- **可用的改进**：独立 Environment 跨任务复用；idle pause 作用于整机；busy Session、keep-warm 条件或 Preview grace 可阻止 pause。有效授权预览打开时，可自动恢复 idle-paused E2B，等待路由就绪，不需要额外模型 turn。[Environments](https://agentmatrix.pro/docs/en/sandboxes)、[Web previews](https://agentmatrix.pro/docs/en/web-previews)
- **明确配置边界**：公开管理员合同 `AdminConsoleCreateSandboxProviderRequest` 的 `sandbox_timeout_seconds` 为 `1..86400`，默认 `1800`，`auto_pause` 默认 `true`；没有 `0`/无限期值。这是 provider 配置合同，**不能推出逻辑 Environment 24 小时必删**，也未证明平台不能续租或恢复。[Admin OpenAPI](https://agentmatrix.pro/openapi/admin-v1.yaml)
- **未公开保证**：租户如何通过当前 SDK 设置 keep-warm、任意子进程/IM 长轮询是否被计入 busy、暂停时本地 timer/cron 的补跑语义、provider 续租策略、异常换机后自定义守护进程是否重启。公开 SDK 的 `idleTimeoutMs` 是客户端流读取超时，不是机器永久运行配置。[SDK 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz)
- **底层依赖仍在**：托管路线明确使用 AgentMatrix 管理的 E2B；不是移除 E2B。另有 Docker/GVisor/容器 provider，但用户是否能选、镜像和持久卷如何供给取决于运营方。未发现 AgentSphere 品牌依赖的证据；E2B 协议/托管依赖有直接证据。[EnvironmentSpecs](https://agentmatrix.pro/docs/en/environment-specs)、[Platform OpenAPI](https://agentmatrix.pro/openapi/platform-v1.yaml)

因此，访问网页自动唤醒可以正面计入收益；而 IM 收发、routines、后台任务是否可 24×7 工作仍需验证。文件仍在和进程一直活着不是同一承诺。

## 如果改用其托管 Session/Agent

| 能力 | 公开合同与迁移影响 |
| --- | --- |
| 引擎 | 新版本支持 `claude_code`、`codex_cli`；旧 `native` 已退休，没有 Pi 或自定义 runtime 注册入口。现有 Pi 不是换 SDK 即保留。[AgentSpecs](https://agentmatrix.pro/docs/en/agent-specs) |
| 自定义工具、MCP | stdio/HTTP MCP 可接入，`enabled_tools` 过滤；内建工具由托管 runtime 所有，新的 `allowed_tools` 必须为空。自定义 host 工具须重新暴露为支持的接口，不能直接塞进旧 native tool 列表。[AgentSpecs](https://agentmatrix.pro/docs/en/agent-specs) |
| 会话中调整 | 可以在 turn 之间通过 `sessions.agentConfig.update` 改 MCP、skills、permission；runtime、system prompt、model 仍冻结。不能误写成“所有配置一旦建 Session 就不能变”。[Sessions](https://agentmatrix.pro/docs/en/sessions)、[SDK 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz) |
| 审批 | 原生模式由各 CLI 决定；回答仅支持请求提供的 `allow_once/deny/cancel`，不支持 `allow_always` 或持久授权。平台问答事件可适配已有 UI，但与自定义权限控制不等价。[Approvals and interactions](https://agentmatrix.pro/docs/en/approvals-and-interactions) |
| 历史、重连与生命周期 | Session 事件可持久回放；每 Session 同时一个 turn；archive 后不能继续写入，继续工作要新建 Session。平台回放不能直接恢复 RaytoneBot 自有 JSON/JSONL 数据结构。[Sessions](https://agentmatrix.pro/docs/en/sessions) |

## 文档漂移与平台实施前需源码/实机核对的阻断项

发现两处需要以当前合同和实际 provider 为准的文档漂移：

1. EnvironmentSpecs 页仍把 Docker preview 写为不支持；Web previews 与当前 OpenAPI 已写 Docker/GVisor 支持，Kubernetes Pod 不支持。
2. EnvironmentSpecs 页称出站默认关闭；当前 SDK/OpenAPI `NetworkPolicy` 指明整个字段省略时 outbound 默认 allow，public_access 默认 deny。迁移应显式提交网络策略，不依赖页面默认值。

SDK `0.11.0` 对应 `0.154.0`，生产 OpenAPI 已是 `0.155.0`；这本身不是已证实不兼容，但说明“装最新版”仍需按在线合同验证。以上差异均已直接核对 [SDK 发布包](https://registry.npmjs.org/@agentmatrix.pro/sdk/-/sdk-0.11.0.tgz)、[Platform OpenAPI](https://agentmatrix.pro/openapi/platform-v1.yaml) 及对应文档页。

部署决策前最小问题集：

1. 是否有受支持的 deterministic exec、进程启动/停止、日志/健康检查、重启后的 bootstrap 机制？普通租户如何调用？
2. 能否提供满足 sudo/用户隔离/nft/ACL/Chromium 要求的 template，以及保留现有 UID/路径约束的方式？
3. 是否有稳定入口、自定义域名或生产 ingress，签名过期怎样处理？preview URL 更新是否会影响现有浏览器认证？
4. 自定义 Node/IM/routine 常驻运行的保障、keep-warm 授权方式、计费与最大连续运行时间是什么？暂停和故障期间的定时任务如何补跑？
5. Workspace 的实际容量、刷新/复制承诺、灾难恢复 RPO/RTO、保留和备份政策是什么？怎样证实“文件已远端持久化”，而不只看本地写入成功？

自有平台应把以上问题分为已有能力核实和需要实现的能力，并逐项验收。在完成前，可以确认平台提供了更好的持久文件资产和自动唤醒机制；不能承诺现有大部分功能无影响，也不能承诺现有整套应用状态获得完整持久化。
