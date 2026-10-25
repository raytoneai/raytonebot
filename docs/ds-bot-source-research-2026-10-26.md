# DS-Bot 源码调查（2026-10-26）

用于与 RaytoneBot 对照。仅调查 DS-Bot，一手来源为 GitHub API 返回的源码与测试；没有安装依赖、执行程序或验证真实模型效果。

调查快照：main 的 HEAD 为 `de55888a93983fc51c94f7d22bc94b4f8293205d`，提交时间 **2026-10-26 00:19:55（Asia/Shanghai）**。固定来源：[该次提交](https://github.com/Fei2411/DS-Bot/commit/de55888a93983fc51c94f7d22bc94b4f8293205d)。

## 定位与架构（事实）

DS-Bot 是 DSH 插件，复用 DSH 的模型、工具、Session 与权限体系；桌面应用只是另一个分发入口。每个 Bot 以 root Session 为基础，群内成员另建 Session，插件通过模块的 `install(rt)` 注册监听器、工具及生命周期。它在 DSH 之上补长期 Bot 配置、群调度、上下文管理、记忆、能力挂载和观测，不是一个值得整体替换 RaytoneBot 多引擎 runtime 的独立 harness。依据：[插件入口与模块装配](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/index.js#L40-L70)、[群成员 Session](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/groups.js#L194-L226)。

## 八项值得对照的实现（源码事实及边界）

### 1. Bot 是独立配置实体

创建时持久化 `role / instructions / model / effort / workDir / capabilities`，不只是姓名和头像；创建后 DSH 默认模型变化不会自动改 Bot 已选模型。system prompt 从当前 Bot 记录生成。更新模型即时调用 applyModel，换目录触发 followFolder，后续以新 part 承接。

依据：[Bot 字段](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/roster.js#L140-L165)、[独立身份注入](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/prompt.js#L40-L54)、[配置更新生效](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/roster.js#L280-L314)。

借鉴判断：先把“两个同引擎 Bot 能拥有不同职责、指令、能力和目录”做实，比增加更多预设头像更有价值。不意味着应自动改用户已选模型。

### 2. 记忆分 Bot / Group / Team，并有主动 recall

物理存储按 `memory/bots/<id>`、`memory/groups/<id>`、`memory/team` 分开。群中默认写群记忆；私聊默认写自己；只有主 Bot 或群管理员可写 team；普通 Bot 不可读取/修改其他 Bot 的记忆。prompt 注入 own + team，只有所在群会话再注入该群 memory。recall 可搜索所有获准范围及完整 topic。每个会话冻结 memory snapshot 来维持前缀缓存，recall 可立即读到新内容，checkpoint 后刷新 snapshot。

依据：[范围与写权限](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/memory.js#L687-L707)、[注入与快照](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/memory.js#L916-L1025)、[recall 范围和检索](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/memory.js#L1156-L1221)。

还实现了每轮后自动 review，按群共用 cursor / queue，群审查只写群范围；提示词要求只保留用户的长期信息，拒绝引用内容和密钥。这是模型提示 + 校验，并非能证明语义上永不误记。[群 review 的归属](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/memory.js#L1561-L1605)、[审查提示边界](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/memory.js#L373-L408)。

**重要边界：群记忆作用域隔离，不等于私聊安全隔离。** README 有“群永不读取 Bot 私聊”的措辞，但新群成员 Session 会注入其私聊的 ownChatBrief，并允许 read_own_chat。借鉴时应明确跨聊引用的可见范围，不能直接复制其隐私宣称。[私聊 brief 注入](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/groups.js#L194-L226)、[brief 内容](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/chat-index.js#L282-L288)。

### 3. 长对话处理区分“仍在做事”和“已到停顿点”

steward 读取最近消息，决定原地 checkpoint 或换新 part。阈值来自模型窗口扣除回复预留，默认 check 80%、hard 95%。checkpoint 提示明确保留结果逐项、未完成请求、用户纠正和精确标识，并把最近用户/其他 Bot 消息与摘要一起携带，避免完全依赖摘要重述指令。摘要空白或被 max-tokens 截断会报错。

依据：[阈值及决策](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/steward.js#L20-L40)、[checkpoint 内容要求](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/steward.js#L110-L129)、[原文携带与截断检查](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/parts.js#L469-L538)、[轮末触发](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/parts.js#L1153-L1173)。

边界：它不是全部用户消息永久原文注入。单条保留上限 4,000 字符，总最近消息预算默认 16,384 tokens，超出需检索历史。steward 失败会默认 switch，且每次增加模型调用；不建议直接把这套覆盖所有引擎原生压缩。[预算](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/parts.js#L191-L211)、[失败退路](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/parts.js#L573-L584)。

### 4. Agent 自己能找回历史，结果带可追溯锚点

`read_own_chat` 背后是日志派生的 SQLite FTS5 索引，trigram 支持中文三字及以上片段，短查询用 LIKE；多词先全匹配，再退到匹配词数量。索引按 Session sequence 增量追赶，可损坏后重建；不可用时扫描日志。结果含 `part N #seq`，around 可读取命中附近消息。prompt 明确要求遇到精确数字、全路径或完整列表时先检索，而非凭摘要猜测。

依据：[FTS 查询与降级](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/chat-index.js#L23-L42)、[建库与重建](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/chat-index.js#L71-L121)、[检索和锚点周边](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/chat-index.js#L180-L258)、[Agent 检索契约](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/prompt.js#L23-L24)。

借鉴判断：优先暴露已有持久日志的 search/read/around 工具与来源链接；FTS 是数据量上来后的可选优化，不应先造向量服务。

### 5. 能力库共享，启用按 Bot 选择

能力可为 skill、MCP 或两者组成的 pack；Bot 记录挂载列表。能力实际装入各 Agent 的 context，包括该 Bot 的私聊和群会话。新增 stdio MCP 未审批不会启动；能力被其他 Bot 使用后，非主 Bot 的原作者也不能改写它。单 Agent 对账链与 15 秒挂载超时，避免坏 MCP 卡住整个团队。

依据：[能力类型及共享修改约束](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/capabilities.js#L18-L35)、[共享使用者保护](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/capabilities.js#L76-L85)、[按 Bot 挂载](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/capabilities.js#L155-L179)、[审批和 Agent context](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/capabilities.js#L266-L338)、[等待上限](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/capabilities.js#L392-L419)。

借鉴判断：先做 Bot 级 capabilityIds / skills 选择即可；不必同步引入任意本地 stdio 或完整插件市场。

### 6. 用量统计覆盖普通对话和隐藏后台调用，并处理重复

日志内调用按 Session + turn + step + retry attempt 计一行，重复 settlement 替换，重试另计，fork 继承的原父会话记录不重复计。SQLite 保存分时、Bot、model、kind 的账本。普通对话从事件日志补录；checkpoint、steward、memory 等额外调用走流计量，通过 tag 区分；同一 usage chunk 经过重写链两次时 WeakSet 去重。

依据：[attempt 去重与 fork](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/usage.js#L48-L92)、[账本与事务](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/usage.js#L134-L187)、[全局调用唯一键](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/usage.js#L368-L374)、[后台调用计量](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/usage.js#L522-L599)。

边界：展示 tokens，README 明确没有成本；删账本后历史 Session 可重建，但后台无日志计量会丢失，故不能称其为完整财务账本。[持久化边界](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/usage.js#L1-L12)。

### 7. 委派任务有依赖关系、回传规则和群内后台工作状态

跨 Bot 工作保存 parent/open/results，父任务等子结果全部回来才答复上游；禁止给等待自身结果的上游重复发起请求。长结果先单独落盘再让 state.json 引用。群内发言仍有顺序，但耗时工具工作经过 grace 后不占住整轮，完成后结果发回群，由请求者跟进；失败、停止、等待审批与仍在工作不同处理。

依据：[任务树与结果持久化](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/handoffs.js#L98-L172)、[拒绝循环委派](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/tools.js#L209-L256)、[群工作让出轮次](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/groups.js#L294-L349)、[迟到结果与失败回传](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/turns.js#L578-L626)。

有对应行为测试：[group-work 测试](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/test/group-work.test.js#L119-L170)。这里只阅读了测试，未运行。借鉴应限于能独立交付的读任务及显式依赖，不应为了“群聊更热闹”放开同目录并行写入。

### 8. 重启恢复先核对持久日志，未知结果不假装成功

`inflight.json` 记录活跃轮次和待取投递，启动后核查已被读取的 exchange 与持久日志；已完成结果送回等待者，无法读到结果则标记 unknown；真正中断恢复时提示先检查文件、命令、已发消息再重复动作。带 request_id 的请求出现 uncertain 不静默重发。

依据：[恢复记录与提示](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/resume.js#L1-L30)、[恢复前对账](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/resume.js#L309-L383)、[不确定请求不重发](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/tools.js#L186-L204)。

边界：inflight 文件有意原地写，源码明确 torn write 会损失恢复记录；它不是事务级 exactly-once。其默认自动恢复也未必适合 RaytoneBot 现有“停止/失败后显式继续”约束。[记录落盘局限](https://github.com/Fei2411/DS-Bot/blob/de55888a93983fc51c94f7d22bc94b4f8293205d/ds-bot/src/host/resume.js#L110-L125)。

## 证据强度与适用判断

- 上述“事实”为固定 commit 的源码所实现的分支与数据模型；每项附直接代码链接。
- “借鉴判断”为设计推断，需与 RaytoneBot 当前 owner、引擎兼容边界和已有功能一起排序；不构成已验证性能收益。
- 已阅读相关测试：memory scope、usage attempt/fork、capability 挂载、group-work 等，未执行测试或真实端到端流程。测试存在不等于当前部署通过。
- 不建议照搬的部分：取代全部引擎压缩、无边界自动跨 Bot 循环委派、把“群 scope”宣称为安全沙箱、为日志检索先上向量库。
