# OpenDuet 一手源码调研（2026-11-01）

本文是固定版本的研究快照，不是开发任务或已采纳的架构决策。与 RaytoneBot 的现状、优先级和既有产品约束一起阅读：[综合竞品重估](competitive-reassessment-2026-10-29.md)、[产品进度](product/03-roadmap.md)。

## 结论

OpenDuet 最值得研究的是把“读到线索 → 判断是否值得打扰 → 给出带依据的建议 → 人选择开始 → 后台执行 → 等输入或交付”做成可追踪的产品闭环。它基于 OpenBot，新增晨报、Tasks、Make 等体验；不能简单理解成新的 Agent SDK，也不只是几个提示词。品牌与 Bots/Skills 可以在 tenant package 配置，但产品实现同时涉及服务端、前端和数据库。[README 定位][readme-architecture]、[工具装配][wiring]、[数据模型][schema]

对 RaytoneBot 更适合学习的是结果覆盖范围、任务型 Skills、已有状态的统一投影、无变化时安静、配置真实可用性与产物修改冲突检测。**不建议因此更换运行时、引入 OpenBot 的整套服务，或复制 Tasks/Make 的独立页面。** 本文不主张增加侧栏结果标签、Bot 汇总或已撤回的交付 badge/read tracking。

## 证据与验证边界

- 访问日期：2026-11-01（Asia/Shanghai）。GitHub 默认分支为 `main`，本次固定到 [`677e0fcd148d80b99dd788c6d6f9c1c9f40a72db`](https://github.com/CopilotKit/OpenDuet/commit/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db)，提交时间为 2026-10-28 22:37:51 UTC，合并公开网页研究 skill。
- 读取 GitHub 仓库元数据、完整文件树和下列固定 SHA 源文件；部分后续 connector 请求停滞，改用相同 SHA 的公开 raw 源文件核对。
- **已核实**指存在实现及其静态语义；没有安装依赖、启动 OpenDuet、调用真实模型、连接 Gmail/Calendar 或进行跨设备/重启实测。没有把仓库自述、测试文件存在或上游提交的评测成绩当成本次运行结果。
- 仓库为 [MIT 许可证][license]。许可证不改变其服务依赖，也不代表框架、模型和外部连接器都已在本项目中验证。

## 运行结构与接入成本

| 层 | 固定版本可确认的情况 | 对本项目的含义 |
| --- | --- | --- |
| 应用基础 | Hono 服务端、CopilotKit runtime，经 AG-UI 接 Agent；OpenBot 提供电脑、审批、审计和聊天渠道。[README][readme-architecture] | 作为模式和实现参考，不是替换现有 Pi/CLI → AgentUX 链路的理由。 |
| 会话与记忆 | 配置代码强制要求 Intelligence API URL、WebSocket URL、API key；运行时始终创建 Intelligence client。[配置检查][config]、[runtime][copilot] | 可以自托管应用，但当前不是开箱即用、完全无外部服务依赖的本地助手。 |
| 启动与状态存储 | 官方 Quick start 需要 Docker、Bun、Node、模型 key 和 Intelligence 项目；README 的架构包含 PostgreSQL/pgvector 与每 Bot 的 computer。[启动说明][quickstart]、[架构][readme-architecture] | 直接迁入会增加本项目目前不需要的运行服务和运维面。 |
| OpenDuet 差异 | YAML 定义品牌、Bots、channels、model、skills；晨报/Tasks/Pages 有独立服务实现和数据库表。[工具装配][wiring]、[表结构][schema] | “放在一个文件夹”不能理解为复制 YAML 就能搬走所有产品能力。 |
| 工具与审批 | computer gateway 从服务端快照解析目标，做 policy 判断、先写审计再执行；主动研究还收紧工具集合及远端 callback。[gateway][gateway]、[主动限制][restriction]、[装配入口][guards] | 可以借鉴“真实目标与调用上下文由主机持有”，不把 README 的“每个动作”宣传语当作所有外部 Agent 的隔离证明。 |

## 主动闭环究竟实现到了哪里

### 1. 邮件分拣：规则先行，来源与失败不被摘要抹平

`triage.ts` 先用窄规则识别 Promotions/Social、自动回复、会议答复等 `can_wait`，剩余邮件交模型判断。规则不会直接判定 `needs_you`；没有将所有 `noreply`、List-Unsubscribe 或 Updates 都判作无事。每个结果带一句原因和 `rule:<id>` / `model:<name>`。模型输出没有有效 verdict/reason 时抛错，而非伪造成功判断。[分拣规则][triage-rules]、[输出校验][triage-output]

晨报调用的是 Gmail 搜索返回的 **snippet**；它不是逐封读完正文。默认取最近一天、最多 50 封，模型分拣并发为 8。模型未能分拣的邮件仍放在 `needsYou`，明确标为 `unsorted`；连接器失败、分拣失败、明确超过上限的未覆盖邮件放入 `couldNotCheck`，同时给出按规则/模型处理数量。[晨报实现][brief]

因此，借鉴点是**把“已检查且无需处理”“未检查”“检查失败”分开**，不是照搬其邮箱分类规则或给整个助手增加 needs-you 看板。`couldNotCheck` 是这个晨报的结构化结果，不能扩大为全平台已有统一的 `partial/no_change` 结果协议。

上游评测用小型虚构邮箱：README 当前说明 62 封；已提交 GPT 结果是此前 60 封，precision 96.2%、recall 100%。维护者明确说标签和提示词由同一人编写，只适合作回归样本，不能证明真实邮箱准确率。本次未复跑，不比较或替换 RaytoneBot 已选模型。[评测范围][triage-eval]、[已提交结果][triage-result]

### 2. 晨报：每天打开 Chat 触发，主机负责持久化 claim

自动晨报由打开 Chat 的前端触发，初次 greeting 当天不再自动发晨报；用户已经输入或开始自己的回合时让路。不是一个已验证的“每天固定时刻主动推送晨报”功能。[前端触发][morning-ui]

服务端用单行条件更新接受**严格晚于上次 claim 的本地日期**，并在同一事务创建 work item。这样多标签页、多个设备、多个服务副本不会仅凭各自前端记忆重复发起；客户端日期还必须在服务器 UTC 日期前后一天内。成功入队后由服务端 worker 处理，打开它的浏览器退出也不取消。[事务 claim][morning-claim]、[日期校验][morning-date]、[后台处理][morning-drain]

这里应学习的是“确定性的触发身份 + 主机持久化接受记录”，而不是让 RaytoneBot 的页面加载隐式重放不确定工作。本项目已有的 occurrence 去重需要与之对照，不能因为不同命名再造一套。

### 3. 后台研究：只读约束、去重和安静有明确边界

后台研究根据上次**成功**运行起点读取增量；首次或上次失败回看一天。指令要求通常不产生建议、没有新发现就保持安静；模型只能提出下一步供人选择，不能自行发送、改应用、委派或控制电脑。工具加载时筛选，执行时再检查，远端 callback 也有同一限制，未知或不能确认为 read 的工具拒绝。[增量指令][proactive-window]、[限制实现][restriction]、[实际装配][guards]

建议去重包括：仍打开的同 Bot 标题、最近 14 天被隐藏的标题；服务端规范化大小写、空白和尾部标点后做相同标题检查，提示词再要求不要改写后重复建议。`runNow` 还设置 10 分钟间隔及时间桶队列 key。**这不是基于来源内容指纹的可靠语义去重**；去重属于 proactive engine，不在 `triage.ts`。[建议检查][proactive-dedup]、[隐藏时间窗][hidden-window]、[手动冷却][proactive-now]

`sourceTool` 被填写时会核对本次审计记录中成功的连接器读取；形成 memory 必须给出这一读取来源。但建议允许不填 sourceTool，不能写成“所有建议都有强制逐条来源”。只有新记录的建议进入通知/聊天 check-in，通知用 suggestion ID 关联，并在 outbox 按事件与目标去重。[来源与投递][proactive-delivery]、[outbox 路由][delivery]

通知有 Bot 级 `all / needs_input / none` 和按类型路由；`needs_input` 只发问题和审批，web 内仍保留结果。偏好读取失败时它选择允许通知，此处是它自己的取舍，不能借此宣称静默承诺严格成立。此次所读链路没有证实统一的时段免打扰。[通知策略][notify-policy]

### 4. Tasks：读现有事实，不额外维护一份运行状态

Task 表没有 status 列。状态由 work queue、pending approval、pending question 等推导；只有用户确认完成的 `resolvedAt` 属于 Task 自己。优先级是 `needs_input → working → resolved → failed → ready_for_review`，每个 Task 有自己的会话，带来源和用户可读的失败原因。[状态推导][tasks]、[数据约束][schema]

这与本项目“状态来自主机/事件，现有组件负责呈现”的规则相容，值得学的是事实来源与投影原则，不是复制独立 Tasks 页面。

需要特别保留差异：该版本 `TASK_RUNS = 2`，第一次抛错或重启中断后允许一次自动再跑，等待用户审批/问题则作为正常挂起结束；另有手工 Try again。队列身份与重试次数不能证明外部副作用恰好执行一次。**不直接迁入 RaytoneBot 的“不自动重放不确定任务”执行路径。**[重试常量][task-retry]、[挂起处理][task-wait]

### 5. Make：持久化结构化产物与冲突检测，不是不可变版本库

`make_page` 将 page/slides/dashboard/doc/design/design-system 保存为结构化 blocks/slides，在聊天中返回卡片摘要，由 Make 列表和 viewer 展示；本次检查到的是站内结构化内容，不足以证明其具备任意应用运行、原生 Office 文件导出或发布能力。[工具契约][page-tools]、[存储结构][schema]

修改前 `read_page` 取得 `updatedAt`，随后 `make_page` 必须带 `expectedUpdatedAt`；服务端事务行锁下比较，再更新同一行。时间戳至少增长 1ms，防同钟写入；checklist 另有 revision，防旧页面位置与新内容错配。[修改与勾选][page-store]

**这是乐观并发控制，不是历史快照。** `layoutVersion` 是 slides 布局兼容版本，`checklistRevision` 是勾选地址版本；都不是每次交付的内容版本。RaytoneBot 如果需要可回看、可下载的交付版本，应另行定义最小快照要求，不能宣称 OpenDuet 已提供同等实现。[工具更新逻辑][page-tools]、[原地更新][page-store]

### 6. Skills 与 Setup：声明需要什么，区分“配置过”和“确实可用”

Skills 附带工具需求，但声明本身不授予权限。公开网页研究使用 `@research/search`、`@research/fetch` 角色，匹配已有 provider 并与 Bot 的 grants 相交；服务端可以按当前请求缩小提供给模型的工具集合，选择失败回退已授权全集，不扩权。[Skill 声明][skills]、[工具选择装配][selection]、[研究连接器说明][research-doc]

这适合作为“任务型 Skill + 所需能力预检”的参考。不能把“声明了 tools”说成“运行前必定检查所有依赖并阻止任务开始”：源码中工具选择与授权是两层，Setup checklist 又是单独能力。

Setup 返回 `ready / needs_setup / not_checked`；实际查 Intelligence entitlement、当前模型 key 的 provider 结果、当前人和 Bot 的 app access，重新检查至少间隔 10 秒。密钥存在但未验证不写 Ready；computer 还能区分服务可达但尚未启动电脑。它报告可验证的边界，不等同于真实任务成功验收。[Setup 定义与检查][setup]

Google OAuth 采用加密 state、PKCE、10 分钟有效期和封闭的回跳目标枚举。fake Google 的显式环境开关只在非 production 生效；production 会警告并忽略，保留真实 Google 地址。可用于合成收件箱回归，但演示结果不能被当成真实 Gmail 验收。[OAuth][oauth]、[fake 隔离][fake-google]

## 六项可以学习的改进方向

以下是研究建议，由综合报告决定当前优先级；不自动转成任务，不更改模型或权限语义。

| 建议 | 最小学习单位 | 应避免的扩大 |
| --- | --- | --- |
| 任务型 Skills | 给现有典型任务写可复用步骤、输入/产物和必要工具需求，先核验可用能力 | 复制全套插件目录或再建 SDK/harness |
| 结果覆盖范围 | 对例行检查区分“成功无变化、部分成功、失败、确有新结果”，保留来源与未检查范围 | 从晨报的一个字段推导出全平台统一状态已实现 |
| 无变化时安静 | 在已有 occurrence 去重之外，研究来源 ID/内容变化指纹；保留隐藏/忽略语义 | 把标题相似度当作可靠去重；新增结果 badge/侧栏汇总 |
| 产物冲突与版本 | 先学习修改前读取及 expected revision；交付快照单独定义 | 把 timestamp/layoutVersion 当作可回滚内容历史 |
| 配置真实预检 | 在既有 Settings 中区分未配置、未检查、验证失败、验证通过，复用现有测试入口 | 增加独立 Setup 应用或把 HTTP 200 当完整能力成功 |
| 回归样本 | 用合成输入复用生产判断函数，记录错误案例与限制 | 把小型自编评测百分比宣传成真实场景成功率 |

## 不宜照搬与尚未证实

- 不因主动助手定位迁入 Docker + PostgreSQL + Intelligence + 多 Agent 服务；研究阶段没有给本项目增加这些服务的需求。
- 不照搬任务异常自动重跑、通知偏好读取失败时放行，以及与本项目审批默认值不同的行为；要分别评估已有安全与用户意图语义。[任务重试][task-retry]、[通知策略][notify-policy]
- 只读研究并不意味着不外发数据。上游自己的研究说明承认模型可能把私有内容放进搜索 query 或 URL；prompt 不是强制数据边界。这限制了“同一个 Bot 同时读私有邮件与任意网页研究”的安全推论。[官方边界说明][research-doc]
- 本次没有验证 SSE/AG-UI 断线重连、远端 Agent 越权阻断的全部路径、真实 Gmail 写操作、通知最终送达、生产部署或 UI 可用性。持久化 claim 和队列存在不等于所有副作用具备 exactly-once。

## 固定版本来源

下列链接均固定到同一 SHA；范围是本次实际核查的关键片段。

[license]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/LICENSE
[quickstart]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md#L90-L150
[readme-architecture]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md#L209-L253
[config]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/config.ts#L991-L1018
[copilot]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/copilot.ts#L1782-L1823
[wiring]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/wiring.ts#L131-L225
[schema]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/db/schema/openduet.ts#L22-L137
[gateway]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/computer/gateway.ts#L476-L735
[guards]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/index.ts#L1799-L1822
[triage-rules]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/triage.ts#L64-L125
[triage-output]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/triage.ts#L192-L253
[brief]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/brief.ts#L173-L311
[triage-eval]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/evals/triage/README.md#L5-L42
[triage-result]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/evals/triage/results-gpt-5.6-terra.md#L1-L14
[morning-ui]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/app/src/components/shell/morning-brief.tsx#L15-L64
[morning-claim]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/channels/routes.ts#L609-L683
[morning-date]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/channels/morning-brief.ts#L11-L25
[morning-drain]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L844-L959
[restriction]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/restriction.ts#L97-L192
[proactive-window]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L273-L327
[proactive-dedup]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L409-L441
[hidden-window]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L103-L107
[proactive-now]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L1015-L1034
[proactive-delivery]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L409-L558
[delivery]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/delivery/router.ts#L117-L182
[notify-policy]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/agents/lifecycle.ts#L365-L425
[tasks]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/task-store.ts#L36-L152
[task-retry]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L80-L100
[task-wait]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/proactive/engine.ts#L748-L841
[page-tools]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/pages.ts#L543-L634
[page-store]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/pages.ts#L399-L538
[skills]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/examples/openduet/skills.yaml#L1-L89
[selection]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/index.ts#L1630-L1669
[research-doc]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/docs/web-research.md
[setup]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/openduet/setup.ts#L12-L92
[oauth]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/plugins/oauth.ts#L6-L100
[fake-google]: https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/openbot/server/src/plugins/catalogue.ts#L509-L569
