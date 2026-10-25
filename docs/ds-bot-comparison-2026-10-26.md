# DS-Bot 与 RaytoneBot：可借鉴的优化

日期：2026-10-26。本文是源码对照和建议，不是已采纳的开发计划。

## 结论与基线

值得优先借鉴的是长期助手的上下文组织：让每个 Bot 有独立配置、让记忆有明确范围、让 Agent 能查回旧消息。其后再补能力分配、用量统计和有限异步委派。现有多引擎、审批、产物、浏览器、Vault、IM、例行任务和持久任务记录可以继续复用，不需要为此换成 DSH 单引擎或另建会话服务。

- DS-Bot：公开 main 的固定提交 [`de55888a93983fc51c94f7d22bc94b4f8293205d`](https://github.com/Fei2411/DS-Bot/tree/de55888a93983fc51c94f7d22bc94b4f8293205d)，详细源码依据见[一手研究记录](ds-bot-source-research-2026-10-26.md)。
- RaytoneBot：本地 `am-hosting`，HEAD `26289199e09bf8d7356f037085e2d5c79466f32c`。核对当前源码、[产品范围](product/01-product-brief.md)、[路线图](product/03-roadmap.md)和相关 ADR，不使用历史完成率判断当前能力。
- 验证范围：阅读代码及测试定义，没有启动 DS-Bot、调用真实模型、对测速度/成本/任务成功率，也没有验证当前线上部署。以下优先级和收益是基于实现差异的判断。

## 值得优化的七项

| 顺序 | DS-Bot 的做法 | RaytoneBot 当前实现 | 建议的最小增量 |
| --- | --- | --- | --- |
| 1 | 每个 Bot 有自己的配置、能力和记忆 | `BotProfile` 仅保存 ID、引擎角色、名字、头像；SOUL 与工作区按 preset 选择 | 在已有 Bot 编辑入口补独立职责/长期指令和可选模型覆盖；缺省继承现有值，不自动更换模型。先不迁移工作区 |
| 2 | 区分 Bot、群和团队记忆，并能主动 recall | 所有成员共享一份记忆；最多 100 条，每条 300 字符，每次注入预算 4,000 字符，优先最新内容 | 在现有 Memory 中增加全局/Bot/群范围；继承旧记录为全局，新增支持显式选择。再提供有范围、有结果预算的记忆查找 |
| 3 | checkpoint 保留近期原话与消息锚点，Agent 可搜索旧聊天并读相邻消息 | 原生会话与压缩已有；用户可搜历史，Agent 没有统一聊天回查工具；群成员提示只补最近 8 条、每条最多 1,500 字符 | 先复用现有消息搜索，开放只读的搜索/按锚点读取工具；Composer 支持显式引用旧对话。补长对话、晚加入成员的约束保真验收 |
| 4 | 能力库统一管理 MCP、skill、pack，再按 Bot 挂载 | MCP 工具集全局提供；Pi 明确禁用机器上的 skills，Claude/DSH 也使用受控资源 | 先让现有 MCP 按 Bot 勾选；之后增加主机托管、按需读取的 skill 文本。保留个人配置隔离，先不做插件市场和任意代码扩展 |
| 5 | 用量按 Bot/模型/时间聚合，处理重试与继承历史的重复统计 | 有时长、输出量、模型请求次数限制及日志；主产品缺统一 token 用量。AgentMatrix 协议原型里的 usage 不代表此链路已接通 | 先记录每轮输入/输出/cache token、耗时、状态和来源，再在 Settings 展示。未知值保留未知；价格有可靠配置后才估算成本 |
| 6 | 群内委派可以独立执行、回报进度和结果 | 已有持久 assignment、一层成员任务、停止、结果回收与重启待核对；成员与流程由本轮路由决定，Agent 不能主动接力 | 后续增加显式 `delegate_task`，先限制一层、已加入成员、只读任务；沿用任务 ID、并发限制与回收逻辑，保留写任务串行和不确定动作不重放 |
| 7 | 用模型上下文限制与上下文占用驱动交接 | Pi 的自定义 provider 注册统一使用 `contextWindow: 128_000`、`maxTokens: 16_384`，价格均为零占位 | 允许经过核实的 provider/model 元数据覆盖，并显示有效配置；继续用原生压缩，不额外叠加一套摘要循环 |

### 1. 自建 Bot 要能形成独立分工

当前两个同为 Pi 的 Bot 可以有不同名字和会话，但配置结构不能表达“一个负责产品研究，一个负责客户沟通”；使用独立工作区根目录时，两者依然按相同 preset 读取 SOUL 和工作目录。本机未设工作区根目录时，各角色也共用当前目录。独立会话不等于独立人格、能力或工作区。

最先补 Bot 级长期指令、可选模型覆盖和能力选择，比继续扩充头像配置更直接影响任务质量。工作区迁移涉及历史文件引用与权限，应作为后续单独选择，不与 Bot 配置捆绑实施。已有 Bot 编辑 owner 是 ShellExtras；沿用该表单和服务端 BotConfigStore。

本地依据：[BotProfile](../src/runtime/botProfiles.ts)、[BotConfigStore](../src/pi/botConfig.ts)、[rolePrompt](../src/pi/rolePrompt.ts)、[workspaceLayout](../src/pi/workspaceLayout.ts)。DS-Bot：[独立 Bot 字段](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/roster.js#L140-L165)。

### 2. 记忆先分范围，再提高召回

现在的记忆适合“默认用中文”“偏好公制”这样的全局习惯；若要记录某个项目的截止时间、品牌规范或某个 Bot 的专用知识，全局列表容易把无关背景带进其他聊天。达到注入预算时，较旧条目仍保存在设置中，但模型收到的提示只说明有若干旧条目未展示，没有配套的记忆读取工具。

建议使用稳定 `botId` 和群 `conversationId` 作为范围身份，保留来源和编辑/忘记入口。群中的记忆不应自动升级为全局；当前用户明确指令优先于旧记忆。第一版不需要向量数据库，也不需要自动从所有对话抽取记忆。

DS-Bot 的群记忆范围确实独立，但它的群成员会话仍可能注入该成员私聊摘要，并提供读取自己私聊的路径，因此不能据此宣称“群完全看不到私聊”。我们若借鉴，应明确历史引用的范围，而不是只给记忆加标签。

本地依据：[memoryTypes](../src/pi/memoryTypes.ts)、[memories](../src/pi/memories.ts)、[记忆回归](../src/pi/memories.test.ts)；当前共享列表是 [ADR-038](product/07-decisions.md) 的明确选择，实施分范围需要修订这一决定。DS-Bot：[记忆范围](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/memory.js#L687-L707)、[私聊摘要进入群成员会话的边界](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/groups.js#L194-L226)。

### 3. 把历史搜索接给 Agent，保留可核对的原话

典型场景是“照我们上周定的规范继续”，以及一个新成员加入已经很长的群聊。当前群会话的可见完整历史仍在，但新成员获得的补充窗口有限；不能把这描述成全部历史已经丢失，也不能保证早期约束必定在它的原生上下文中。

建议顺序：

1. 复用现有 conversation/textId 命中，返回有界片段和来源；允许按锚点读取前后若干条消息。
2. 默认读取当前范围；跨会话内容由用户明确引用或显式授权范围，不把所有私聊默认注入群里。
3. 把用户原始要求、后来纠正、尚未完成事项作为长对话验收目标；不以摘要存在就认定没有遗忘。
4. 搜索性能先用真实规模数据测量。当前扫描 JSON，可以先保留；只有测出明显瓶颈再评估可重建索引，不能仅因为 DS-Bot 用 FTS5 就引入 SQLite。

DS-Bot 的 checkpoint 同样有预算与截断，不代表无限上下文或永不遗忘。我们应借鉴“摘要旁保留可回查证据”，继续让 Pi/Claude/Codex/DSH 管理各自原生上下文，避免双重压缩。

本地依据：[群成员提示](../src/pi/groupChat.ts)、[搜索匹配](../src/pi/conversationSearch.ts)、[搜索存储路径](../src/pi/conversationStore.ts)、[原生压缩事件映射](../src/harness/adapters/piAdapter.ts)。DS-Bot：[原话保留](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/parts.js#L469-L538)、[检索与锚点](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/chat-index.js#L180-L258)。

### 4. 能力按需挂载，避免所有 Bot 拿到全部工具

当前 `mcp.toolkit()` 聚合所有已启用服务器的工具，各引擎读取同一工具集。先增加 Bot 到 MCP server 的选择关系，就可以让研究 Bot 使用资料工具、实现 Bot 使用开发工具，并减少无关工具说明。减少 token 或误调用是预期收益，尚无本项目的对测数据。

Skills 的缺失部分来自明确的隔离设计：Pi 使用 `noSkills: true`，Claude 不加载个人插件配置，DSH 关闭 skill 插件。应新增受控的产品能力配置，而不是直接打开宿主机器上的所有技能目录。执行脚本继续经过原有工具与审批。

本地依据：[MCP toolkit](../src/pi/mcpServers.ts)、[Pi 资源加载](../src/pi/piResources.ts)、[Claude 启动参数](../src/pi/cliHarness.ts)、[DSH profile](../src/pi/dshHarness.ts)。DS-Bot：[按 Bot 挂载能力](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/capabilities.js#L155-L179)。

### 5. 用量先可解释，再做预算控制

目前已有每轮 30 分钟、100 次模型请求、10 MiB 输出的默认上限，不能说完全没有预算控制。缺口是用户无法在主产品中比较“这次群协作用了多少 token”“哪个 Bot 经常失败重试”。

统一计量需要区分单次请求与原生累计计数，处理重复事件、重试、恢复及分支继承；路由和标题生成也要注明是否纳入。当前 Pi 注册中的零价格是占位，不应当成实际费用。第一版统计可以沿现有主机存储，不需要独立监控服务；新增 Settings 用量入口前先补 owner 与验收规格。

本地依据：[运行限制与日志](../src/pi/hostOperations.ts)、[模型网关](../src/pi/runtime/modelGateway.ts)、[provider 注册及调用入口](../src/pi/piHost.ts)、[Settings 分区](../src/components/settings/SettingsDialog.tsx)。DS-Bot：[attempt 与 fork 去重](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/usage.js#L48-L92)。

### 6. 异步委派有价值，但应排在基础能力后

DS-Bot 的“成员接任务后独立工作、回群报告”值得参考。我们已经有任务身份、子任务、结果回收、待核对恢复，因此应扩展这些记录，而不是重新造任务系统。它与我们当前固定讨论/计划实施评审流程的差异，主要在任务发起者和执行是否阻塞原群轮次。

第一步可只让主持通过显式工具委派一层只读研究，返回 task ID；完成后结果只回收一次。聊天文本里的普通 `@`、引用或代码片段不要直接产生后台任务。后续才考虑写任务、更多成员主动委派和嵌套任务。重启结果不明仍标待核对，不能照搬自动续跑策略。

本地依据：[groupTasks](../src/pi/groupTasks.ts)、[groupChat](../src/pi/groupChat.ts)、[T5.5 验收边界](product/03-roadmap.md)、[ADR-032/045](product/07-decisions.md)。DS-Bot：[任务关系和回收](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/handoffs.js#L98-L172)、[群轮次让出](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/groups.js#L294-L349)。

## 建议实施顺序与验收

推荐先做独立 Bot 配置和记忆范围，再做可引用的聊天历史；MCP 分配与用量采集可作为随后的小任务，异步委派另立规格。模型窗口元数据可独立小修，不改变默认模型。

| 任务 | 最小验收场景 |
| --- | --- |
| Bot 独立配置 | 两个同引擎 Bot 使用不同指令；改名不改变身份；刷新、IM、例行任务和群聊仍使用正确配置 |
| 记忆范围 | 群 A 的专用事实不进入群 B；全局偏好仍共享；旧记录保持原行为；修改/删除/关闭后下一轮有明确效果 |
| 历史回查 | 新成员能按引用找到早期约束和后续纠正；返回原消息锚点；删除、超范围和截断有反馈 |
| MCP/skills 分配 | 未分配工具不出现在该 Bot 工具表；移除/禁用及时生效；工具执行仍经过原审批 |
| 用量 | 流式结束、失败重试、断线重连和分支继承不重复记账；未知值不显示为零；辅助调用范围可解释 |
| 有限委派 | 不阻塞原群继续交流；停止、迟到结果、重复回报、容量等待与重启结果不明都有确定行为 |

以上是建议验收，尚未执行。此次仅新增研究文档，未修改运行时代码、默认模型或部署。
