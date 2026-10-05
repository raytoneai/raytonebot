# Jev 类判断模型与 harness：可核验用例

调研日期：2026-10-04。范围是工具选择、协作、上下文和记忆；模型档位路由另行整理。仅查作者仓库、源码、实验记录和 GitHub API；未安装或运行这些项目。下列为社区/框架方实现，不能当作 TypeSafe 官方产品承诺。

## 1. 浏览器：判断模型选动作，生成模型负责填内容

[Browser Use 的 jev-ultrafast](https://github.com/browser-use/jev-ultrafast) 每次把页面变成带编号的可操作元素表，Jev 同时选择操作和对应目标；只有 `TYPE_TEXT` 才调用小 LLM 写文字。执行器重新检查节点、页面状态和遮挡，完成另有结果验证。

这是本组最有关注度的实例：仓库 2026-09-16 创建，查询时约 2.19 万 stars。[GitHub 元数据](https://api.github.com/repos/browser-use/jev-ultrafast)

作者展示了 7.073 秒 Flights 任务；优化对照只有同一任务两组各三次，不是广泛可靠性评测。它仍是 MVP，iframe、canvas、文件上传等超出范围。[实验范围](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md)

**可借鉴（推断）：** 主 Agent 先生成有限候选操作，判断模型处理重复的局部选择，参数、权限、真实执行和验收留在既有工具代码中。很适合稳定网页或文档批处理中的语义分支。

## 2. LLM 写策略，判断模型反复执行；失败轨迹供 LLM 改策略

[JevHarness](https://github.com/TianyuCodings/JevHarness) 让 LLM 编写特征计算、问题、候选动作和控制流程；定稿后冻结 harness，执行不需要每个决策再调用作者 LLM。可选反思读取完整轨迹和可信奖励，修改策略后重新评估。仓库保留了候选、失败轨迹和选中的策略。

宝可梦对战例子报告五轮反思后，从 3/12 胜到 9/12 胜，选中第三轮策略；**Eval 同时用于选择，因此不是独立测试集上的泛化成绩**。这是原型证据，不是对任意工作流的效果保证。仓库 2026-09-21 创建，查询时 524 stars。[元数据](https://api.github.com/repos/TianyuCodings/JevHarness)

**可借鉴（推断）：** 给重复出现、结果能客观检查的任务建立少量流程：大模型设计流程，规则计算事实，小模型选择分支；遇到未知状态、连续失败才把轨迹交回大模型。这比让小模型理解整项开放任务更合理。

## 3. 工具和技能发现：先召回候选，再判断具体是否适用

[pi-jev](https://github.com/TheoOliveira/pi-jev) 已有 `jev_find_tools`、`jev_find_skill`，可按需激活未启用工具，推荐相关技能；自动模式默认关闭，也支持指向 Laya 兼容接口。仓库 2026-09-17 创建，查询时 62 stars。[元数据](https://api.github.com/repos/TheoOliveira/pi-jev)

[工具路由源码](https://github.com/TheoOliveira/pi-jev/blob/main/src/router.ts) 先做廉价候选召回，再每个候选问一个 Noul；失败不激活未判定工具。这里值得借鉴的是“短列表 + 适用性复核”，不是复制当前英文关键词召回器。

作者有一份很有价值的[2026-09-25 错选技能复盘](https://github.com/TheoOliveira/pi-jev/blob/main/docs/skill-routing-investigation.md)：原问题把“共同讨论模型”误当成“需要此产品的配置技能”；改为同时匹配**具体动作、产品和工作流**后，开发用 16 条样例各重复三次，错误从 6/48 变为 0/48。样例参与调试，不能当作泛化评测；候选召回漏掉正确技能的问题仍存在。

**可借鉴（推断）：** sandbox 工具目录先通过文件类型、能力标签和描述召回，再让判断模型推荐 3–5 个条目。只影响优先展示，不隐藏完整目录，也不因高分直接执行命令。

## 4. 上下文与记忆：挑选原文，而非每次重新生成摘要

[pi-jev-context-curator](https://github.com/Shashank-H/pi-jev-context-curator) 在 Pi 的 `context` 事件中裁剪本次发送内容，保留存储中的完整会话；工具调用与结果作为整体，系统消息和最新单元受保护，失败时保留原上下文。默认超过约 8,000 token 且每五次调用才判断，避免小上下文平白增加延迟。仓库 2026-09-18 创建，查询时 6 stars，属于早期集成；未发现可据此确认端到端质量保持的独立成绩。[元数据](https://api.github.com/repos/Shashank-H/pi-jev-context-curator)

[dsh-memory-jev](https://github.com/Towzai/dsh-memory-jev) 则把记忆拆成写入、召回重排、是否注入三步；原文不由判断模型改写，删除可恢复，注入内容放在尾部以保持已有前缀。需特别区分：其写入实际上总会持久化，低分只是 `needsReview`；[测试源码](https://github.com/Towzai/dsh-memory-jev/blob/main/tools/test_gates.mjs) 明确使用 `FakeJevServer`，证明的是分支行为，不能证明语义判断准确。仓库 2026-09-20 创建，查询时 0 stars。[元数据](https://api.github.com/repos/Towzai/dsh-memory-jev)

**可借鉴（推断）：** 先用于“从搜索/日志/记忆候选中挑出值得主 Agent 看的一部分”，保留原始证据与回退入口。长期记忆永久淘汰和会话事实裁剪需要比展示排序更严格的验证。

## 对本项目的判断

最先值得试的是**工具/技能推荐**和**大输出/检索结果重排**：结果可观察，错了容易恢复。其次是有固定状态和客观验收的重复任务流程。上一轮本机 Laya 已出现高置信度误判，因此这些架构可以借鉴，但不能把商业 Jev 示例成绩转移给本地 Laya；尤其不能直接把权限批准、任务完成验收或永久删除交给它。

本地运行方式也有现成参考：[laya-agents](https://github.com/lesterppo/laya-agents) 为 Hermes 提供常驻模型实例，为 Muse 提供单进程 JSONL 批处理，避免每条命令冷启动。它是小型社区集成，文档自报的语义结果与离线接线测试应分开看；核心借鉴是进程复用，无须 MCP。
