# Rakazo 功能与 UI/UX 一手源码笔记

核查日期：2026-10-27。对象：[elie222/rakazo](https://github.com/elie222/rakazo)，固定提交 [`09331978998d529921c832d5be014778b9aa1d3c`](https://github.com/elie222/rakazo/commit/09331978998d529921c832d5be014778b9aa1d3c)。通过 GitHub connector 读取提交、目录树和前端实现。本笔记属于源码层面的交互核查，没有运行 Rakazo 完整服务、真实模型、授权、定时任务或接管流程；不把代码路径存在等同于端到端可用。

最值得学习的是**让工作过程、所需授权、交付物和后续自动化都能从当前任务继续操作**。下面的建议是对 RaytoneBot 的产品判断，不是 Rakazo 官方结论，也不是已批准的开发任务。RaytoneBot 当前已有哪些能力，应以 [路线图](product/03-roadmap.md) 和现行代码为准。

## 1. 首次使用围绕“先做什么”，而非先配置全部能力

**源码事实。** 首次引导在模型连接后创建或复用 Chief；第一次聊天的选择卡问用户先处理什么，提供日常工作、邮箱、研究写作、综合四类，可关闭，也可导入已有 Agent。选择提交期间禁用操作，保存失败原位显示错误。[首次 Bot 创建](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/Onboarding.tsx#L94-L146)、[聊天选择卡与场景选项](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/message-cards.tsx#L17-L147)。

**学习点。** 首页给少量可直接开始的任务方向；需要哪项能力，就在任务中补齐。RaytoneBot 可在既有欢迎区/Composer 使用真实任务示例，不必新增向导或复杂角色配置。

**边界。** Rakazo 仍有模型、问卷等引导步骤，不能据此宣传“零配置”。任务方向选择也不证明连接器或模型已就绪。

## 2. 运行过程默认可读，完成后让位于结果

**源码事实。** 工具活动默认在执行时展开，结束时折叠；标题包含执行中/完成、工具调用总数，结束后显示耗时。执行中只展示最近六步，并给出更早步骤数量；纯工具消息以细行展示，避免每次调用都占一个聊天气泡。用户手动展开/折叠在当前执行阶段内保留。[工具活动](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/components/ToolActivityDisclosure.tsx#L15-L140)。

**学习点。** 把“正在做什么”压缩成可扫读摘要，详情按需展开；完成后正文和产物成为视觉中心。RaytoneBot 应沿用 ChatFrame 的现有工具生命周期及 Output 控制台。

**边界。** 不能照抄标题中的统一 Done：RaytoneBot 必须继续区分失败、取消、等待授权、部分完成。运行阶段自动折叠也应尊重用户正在读详情的状态。Rakazo 的工具活动还受显示偏好影响，[显示规则](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/lib/tool-activity-view.ts#L9-L48)不保证每条内部进度都显示。

## 3. 缺少连接时，把授权放在任务现场

**源码事实。** AppConnectCard 展示应用名称、描述、标识和 Authorize；点击打开授权窗口，卡内显示 Waiting、Connected 或超时错误。MCP 卡展示服务器及 endpoint，区分需要 OAuth 和直接批准，提供 Not now；已连接/已略过状态写在消息 block 上，重新挂载后保留。[应用连接卡](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/message-cards.tsx#L149-L243)、[MCP 授权卡](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/message-cards.tsx#L329-L450)。

**学习点。** 用户看到“为什么卡住—现在能做什么—是否已解决”的完整闭环，减少跳去设置、找项目、再返回重发的负担。RaytoneBot 复用 `chatframe/approval.tsx` 和 SettingsDialog，保留统一状态与回执。

**边界。** 这里证明前端请求与反馈，不证明任意连接器成功率或授权完成后任务一定无缝续跑。账号连接、MCP 批准、每次外部动作授权不能混为一种权限。

## 4. 例行任务有说明、时区、试跑和可追溯历史

**源码事实。** 例行任务编辑器提供 Active、Test run、名称、自然语言 Instruction；When to run 明示时区，扩展选项收在 Advanced。支持添加不同 trigger；保存要求至少有一个触发器。编辑现有任务时附运行历史，条目包含时间、非成功状态，失败有摘要和可展开详情；有 messageId 时能直达对应 Bot/群聊中的具体消息。[任务编辑主区](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/RoutineEditor.tsx#L448-L510)、[触发与保存](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/RoutineEditor.tsx#L655-L747)、[运行历史](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/RoutineRunHistory.tsx#L18-L113)。

**学习点。** 自动化不能只显示开关。用户需要明确知道做什么、何时跑、上次结果在哪、失败原因是什么。RaytoneBot 可在 SettingsDialog 的 routines 原入口优先补足摘要、历史及消息定位；继续由聊天创建任务。

**边界。** Watch、Git/Webhook 等高级触发会扩大主机能力范围；不能只复制输入表单就认为已有可靠唤醒。Test run 是真实执行入口，产品文案应明确副作用，不能包装成纯模拟。

## 5. 交付物可重新找到，也能看版本

**源码事实。** Artifacts 有跨 Bot 列表、Bot 筛选、名称/描述搜索、日期筛选和卡片/列表切换；预览提供版本选择、下载、最大化，支持 HTML、Markdown、PDF 等既有预览类型。[列表与搜索数据路径](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/Artifacts.tsx#L92-L178)、[筛选和视图入口](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/Artifacts.tsx#L215-L345)、[版本与预览](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/Artifacts.tsx#L791-L935)。

**学习点。** 产物既是本轮结果，也是之后会找回的工作资产。比增加更多文件图标更有价值的是清楚标明名称、作者/所属 Bot、时间、版本，以及打开后能返回原任务。RaytoneBot 应扩展现有 OutputFrame 产物来源，避免另建文件中心或把所有工作区文件混入产物。

**边界。** 此快照的关键词和日期过滤发生在已加载页；无命中才继续自动翻页，已经找到命中时不会因此穷尽历史。这不是完整服务器全文搜索。版本选择 UI 也不等于可回滚整个工作区。

## 6. 电脑预览、打开、接管是不同动作

**源码事实。** 小尺寸电脑预览禁用指针输入；鼠标悬停或键盘聚焦显示 Open。打开完整电脑窗口后显示 Take control；拥有控制权时显示 You have control，Agent 请求用户接管时显示 Needs you，并提供交还操作。普通 iframe 输入要求用户持有控制权；录制教学时由单独捕获层处理，iframe 本身禁用指针。状态文案区分启动中、休眠、启动失败和停止。[只读预览](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/computer-panel.tsx#L64-L132)、[控制权与输入](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/computer-overlay.tsx#L88-L200)、[状态文案](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/computer-view.tsx#L5-L28)。

**学习点。** 看见浏览器不等于已接管；界面必须回答“谁在控制、现在能否输入、完成后如何交还”。RaytoneBot 用现有 Output 浏览器承接，视图可见时才连接。

**边界。** 上述是 UI 控制语义；未实测其服务端锁、停止/交还竞态和断线恢复。悬停才显示主操作对触屏发现性不理想，RaytoneBot 不应照搬。

## 7. 协作保留来源，让子过程按需展开

**源码事实。** 普通聊天内用 Messaged/Message from 标记 Bot 间消息，点击可查看双方只读记录；接收方回复有展开/折叠入口。临时子 Agent 卡默认只显示名称、状态和一行任务，展开后才展示完整任务及进度/结果；执行中卡替换为持久消息时保留用户展开状态。[消息归属](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/message-view.tsx#L300-L323)、[双方记录](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/PeerMessagesOverlay.tsx#L18-L61)、[子 Agent 摘要](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/components/SubagentCard.tsx#L14-L89)。

**学习点。** 用户首先需要知道谁负责、谁已完成、结果如何合并；不必同时阅读所有成员的全部内部过程。RaytoneBot 保留 ChatFrame 署名、现有工具详情和群成员入口，取用摘要与溯源方式。

**边界。** peer 私信和子 Agent 卡证明两种展示模式，不能据此把它们当作同一种群聊调度。RaytoneBot 也不需要复制 Rakazo 的独立全屏对话弹层。

## 8. 搜索结果直接落到工作上下文

**源码事实。** 侧栏搜索结果展示类型、所属 Bot/群名和上下文片段；选中后将 messageId 或 routineId 写入路由参数，跳到对应聊天或例行任务。搜索输入做 200ms 延迟和旧响应丢弃。[结果信息](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/SpaceSearch.tsx#L28-L53)、[搜索与定位](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/use-sidebar-search.ts#L39-L79)。

**学习点。** 搜索不止找“某个聊天”，应让用户接着处理找到的消息或任务；结果行的类型和归属比堆更多筛选按钮更重要。RaytoneBot 已有逐消息搜索与定位，扩展时应检查具体缺口，不能把这一项笼统列为尚未实现。

**边界。** 此快照 catch 搜索错误时清空 hits，显示层可能呈现 No results，缺少明确失败语义；这是不应学习的点。没有核对后端搜索索引覆盖范围，不称作全资源搜索。

## 9. 从当前 Bot 进入设置，并让资源范围可见

**源码事实。** 聊天顶部的 Bot 名称和头像是当前 Bot 设置入口，右侧保留电脑入口，头像接收该 Bot 的运行状态；不是先去全局设置再找目标。[上下文入口](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/chat-header.tsx#L47-L95)。Bot 面板把模型、思考、电脑配置、语音分组；已配置外部记忆 provider 时才显示 Memory scope，提供 Inherit default / Isolated / Shared。记忆 provider 设置页明确说明语义记忆与 MEMORY.md 并存。[Bot 设置与记忆范围](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/shell/bot-panel.tsx#L600-L684)、[记忆说明](https://github.com/elie222/rakazo/blob/09331978998d529921c832d5be014778b9aa1d3c/apps/web/src/pages/MemorySettingsOverlay.tsx#L225-L245)。

**学习点。** 对长期助手，当前聊天应能直达当前 Bot 的能力和设置；用户应知道记忆属于谁、电脑是共享还是独立、当前模型是什么；仅在相关能力存在时露出配置。RaytoneBot 首先完善已有 Bot/SettingsDialog 的范围说明和记忆可编辑性即可。

**边界。** 这些选项不证明相应隔离达到安全边界，也不构成迁移图数据库或记忆服务的理由。本次没有验证记忆存取质量。

## 取舍与核查记录

- 优先借鉴：工具过程的密度管理、例行任务的运行记录、任务现场连接授权、产物的可找回性、浏览器控制权反馈。
- 已有能力先改交互：搜索、记忆、群聊、MCP、例行任务、浏览器、产物均须先对照 RaytoneBot 当前实现，不重新做一套入口。
- 暂不由这次研究推动：Graph 数据库、多用户计费、整套控制平面、多端客户端、更多 sandbox provider。它们不能直接证明单用户核心体验会改善。
- 不照搬的细节：搜索错误表现成空结果、工具终态统一写 Done、只在悬停时露出的主操作、客户端部分数据过滤却让用户误以为已搜遍全部历史。
- 核查覆盖：固定提交与 3,785 项目录树；读取相关 UI、交互 hooks 与格式规则。未安装依赖、执行上游测试、启动服务或声称视觉实测。行号均来自该固定提交的实际文件。
