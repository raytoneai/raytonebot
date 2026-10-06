# 02 架构

## 当前架构（2026-10-04 工作树；生产实例尚未更新）

```
浏览器  React UI（AgentCanvas 导出组件 + AgentUX 渲染）
   │  HTTPS + Basic Auth（仅云端）
   ▼
AgentSphere 沙箱 agentmatrix-v1（2C/4G, Linux x86_64, Node 24）
   scripts/cloud-preview.mjs   鉴权、Host/Origin 校验，然后交给 Vite preview
   vite preview + piRuntimePlugin   静态 dist + /__agentcanvas/pi/* 接口
   src/pi/piHost.ts            HTTP 控制器 → 按 agentPreset 分流到 Pi 或 Claude Code / Codex CLI
   @earendil-works/pi-coding-agent  模型循环 + 7 个工具 + 审批闸门
   cwd = /home/user/workspace/agents/<角色>/（RAYTONEBOT_WORKSPACE_ROOT）
   数据 = /home/user/.raytonebot/data/（对话 JSON + Pi 文件会话）
```

本机开发时链路相同，只是 `npm run dev` 监听 `127.0.0.1:5188`，没有 Basic Auth，由 `requestOrigin.ts` 只放行 loopback。

### 请求接口（`src/pi/piClient.ts` ↔ `src/pi/piHost.ts`）

计划更新复用既有事件存储与产物视图：Codex `turn/plan/updated`、旧 exec `todo_list`、Claude `TodoWrite` 和原生 `TaskCreate/TaskUpdate/TaskGet/TaskList` 成功回执 → 内部 `plan_update`；Pi `update_plan` 的成功工具结果也进入 `piAdapter` 的结构化 `artifact.delta` 快照。每轮一个稳定产物 id，后续完整快照替换其 data；`taskPlan.ts` 在展示时转换成 Markdown，并根据所属 run 的终态显示结束/停止/失败，不推断未完成步骤成功。打开的产物标签按 id 跟随内容更新，不按标题匹配。计划产物没有工作区路径，下载使用实际内容 Blob；没有新增 HTTP 路由或独立任务数据库，见 ADR-018。

Claude 原生任务投影（71 行）另保留 task id、owner 与 blockedBy；76 行计划模块校验边界并在既有 Markdown 产物显示负责人和仍未完成的前置任务。TaskGet 没有 owner 时保留已确认值，TaskList 为完整负责人快照；TaskUpdate 仅应用成功回执确认的字段，未知依赖 id 标记待核对，后续原生读取解除标记。TaskList 本身会过滤已完成依赖，因此这里是最近回执的展示投影，不是完整依赖图、调度器或子 Agent 状态；执行状态仍归原生任务文件所有。停止不改写原生任务为 completed。

`planTool.ts` 是 Pi 的第八个工具，仅校验并返回计划数据，不访问文件、网络或子进程；原七个 I/O 工具继续在独立 UID worker 中执行。`claudeTaskPlan.ts` 只投影原生成功回执；task id 随快照保存，续接同一 CLI session 时从最新快照初始化，冷启动不沿用。Claude 原生任务文件位于 `.claude/tasks/<session-id>/`，与 `.claude/projects` 一起备份/迁移；依赖、所有者与委派结果仍由原生 CLI 管理，当前 UI 只呈现步骤与状态。

用户提问复用现有事件存储：`run.awaiting_input` 携带唯一 requestId、toolCallId 与已校验问题；回答先写用户消息和 `tool.call.progress.inputRequestId` 并 flush，再确认 HTTP。`UserInputGate` 不读取权限模式或 always-allow；仅保留最近 100 个内存回执供同回答重试，不是持久消息队列。刷新后仅对仍活跃的等待显示控件，重启沿用会话中断终态，不恢复执行。`userInputEventsForReplay` 在真实 replay 入口隐藏已有消息所代表的工具 JSON，原始事件/游标不变。

Pi 第九个工具 `ask_user` 只等待用户，不访问文件、网络或子进程。Claude 问题先于 permission gate 分流，回答写回原生 `updatedInput.answers`；Codex 启用现有 `features.default_mode_request_user_input`，回答保留原生字符串数组，处理 `serverRequest/resolved` 撤销。控件状态由 shell 的小 hook 持有，开关 Output 不丢失；现有输入框修复回传，不新增组件。秘密输入请求拒绝收集，凭据仍走设置页。49 行 `userInputDraft.ts` 使用当前标签页的 sessionStorage，按 conversationId/requestId 保存选项、自由文字和题目进度；恢复前按当前问题校验，不保存 pending/done 等提交状态，不自动发请求。84 行表单 hook 保留内存输入并通过既有 hint 显示保存失败；观察到问题结束或收到确认时仅清理对应 requestId，迟到确认不能删除新题草稿。此数据不跨标签页／设备同步，不进入沙箱备份，关闭标签页后的保留不作保证，详见 `issue.md`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/__agentcanvas/pi/health` | 无模型调用的进程健康、活跃任务数、并发上限与运行时长；云端仍需 Basic Auth |
| POST | `/__agentcanvas/pi/files?scope=&name=` | 单文件原始字节上传，≤10 MiB；返回 `{scope,path,name,size}`，重名不覆盖 |
| GET | `/__agentcanvas/pi/files?scope=&path=` | 当前角色或 shared 工作区的只读目录列表 |
| GET / HEAD | `/__agentcanvas/pi/files/download?scope=&path=` | 下载普通文件，支持单段 Range 与元数据读取，强制附件响应；拒绝隐藏路径、链接与越界路径 |
| GET | `/__agentcanvas/pi/state?conversationId=` | 模型、工具、会话信息 |
| POST | `/__agentcanvas/pi/config` | provider/model/thinking/会话 key |
| POST | `/__agentcanvas/pi/prompt` | 发起一轮，返回 NDJSON 事件流；可选 `requestId` 对应该轮 `runId`，用于断线后核对提交；**连接断开不中止**，只有 `/abort` 停止 |
| POST | `/__agentcanvas/pi/group/prompt` | 群聊轮次，成员经现有 `runPrompt` 执行；群请求以已落盘事件去重，使用同一 `/live`、`/abort`、`/approval`、`/input` 接口恢复和交互 |
| GET | `/__agentcanvas/pi/conversations/:id/live?after=N` | 重新接上运行中的一轮：先补发第 N 个之后的已存事件，再推实时事件，轮次结束时关闭；未在运行返回 409 |
| POST | `/__agentcanvas/pi/abort` | 新界面传 `{conversationId,runId}`，仅停止匹配轮次；过时/已结束返回 409，非法身份返回 400；旧调用省略 runId 沿用按会话停止，空对象仍为管理用停止全部 |
| POST | `/__agentcanvas/pi/approval` | `yes` / `always` / `no`；新界面携带 `conversationId`、`runId` 和原生 `toolCallId`，只匹配对应轮次；409 = 已失效 |
| POST | `/__agentcanvas/pi/input` | `{conversationId,requestId,answers}`；answers 为问题 id 到字符串数组的映射，null 明确跳过；400 校验失败，409 已失效或回答冲突 |
| POST | `/__agentcanvas/pi/session/new` | 新会话 |
| GET | `/__agentcanvas/pi/conversations?query=` | 对话列表（侧栏恢复）；可选 query 搜索标题和用户／助手正文，≤200 字符，返回逐消息 `matches`（片段、textId、角色、时间），保留首个 snippet/textId 兼容旧客户端，不返回全文；可选 limit=1..100/cursor 按消息分页并返回 nextCursor；`running` 和临时 `activeRunId` 标出正在运行的轮次；`unreadable` 单独列出无法读取的记录 id |
| GET / DELETE | `/__agentcanvas/pi/conversations/:id` | 读取历史事件 / 删除对话；读取错误不是 404，临时 `activeRunId` 用于恢复当前运行，`incomplete` 表示当前没有运行但已保存的最后一轮缺少终态 |
| POST | `/__agentcanvas/pi/conversations/:id/branch` | `{beforeRunId}`；201 返回独立 `conversationId` 与原始 `draft`，只保留所选轮次之前的记录，不执行草稿；来源运行中或无可靠边界返回 409 |
| POST | `/__agentcanvas/pi/provider/test` | 模型服务连通性测试 |
| GET | `/__agentcanvas/pi/channels` | IM 频道（飞书/钉钉/企业微信/Telegram）设置与连接状态；已保存的密钥只回报是否已设置 |
| POST | `/__agentcanvas/pi/channels/:platform` | 保存一个频道：`enabled`、`fields`（密钥留空保持不变）、`access`、`allowUsers`、`agentPreset`、`model`（默认模型服务定义，不含 key）；凭据或开关变化时重连 |
| POST | `/__agentcanvas/pi/approvals/clear` | 清除某 Agent（`agentPreset`）或全部的「始终允许」 |

`/prompt` 可带 `attachments: [{scope,path}]`（最多 10 项）。服务端验证文件属于当前角色或共享工作区，再把绝对路径加入模型上下文；界面与保存的用户消息保留原文。上传失败保留草稿与附件，准备阶段可取消。浏览器 Output 面板复用为文件列表、目录导航及下载入口。

会话搜索沿用文件存储，37 行 `conversationSearch.ts` 按 runId/textId 拼接正文增量，不检索工具参数、思考或原生文件。每条命中消息返回一个片段；会话摘要保持每会话一份。62 行 `useConversationSearch.ts` 管理 200ms 防抖、取消、迟到响应及失败/部分结果，并将 matches 展开为按消息时间排序的结果；显示日期不改写会话元数据。复用既有搜索弹层、结果行与状态文字，按 conversationId/textId 联合标识，方向键与回车选择。未发送草稿保留本地标题匹配，正文请求上限 15 秒；选中结果后读取该会话并定位命中的消息。查询发现活跃会话时只订阅原任务，不重发提示词。分页用 36 行 `conversationSearchPage.ts`，服务端与客户端共用按时间降序、会话 id/textId 的稳定排序；游标绑定查询和最后一项的位置，删除游标对应消息不会让后续项跳过。新客户端每次请求 100 项并按需续页；旧客户端不传分页参数保持原返回。下一页失败保留已加载结果，关闭/换词取消全部相关请求。当前仍逐记录扫描，游标不是快照：查询期间新增的较新结果需重新查询；没有新增索引、数据库或全文下载，大量历史扫描性能和跨资源搜索仍待补。

搜索结果复用现有 SessionGroup，由 97 行 `useSearchWindow.ts` 测量可见行高度并保留上下缓冲区；未挂载行仍保留布局位置，焦点行离屏时单独保留。键盘按完整结果顺序导航，换词/关闭重置窗口，窗口宽度变化按消息标识保留阅读位置。片段不截成固定行数，不新增组件或依赖；已加载结果仍存在客户端内存，位置计算为线性扫描，不是全文索引或无限数据规模保证。

显示视图由现有 `replayAgentUXEvents` 校验/排序和 `createAgentUXViewModel` 同步派生，再用 React useMemo 缓存。避免 effect 回放让已切换会话的搜索目标命中上一会话的 DOM；没有修改 vendor 或另建回放实现。滚动 hook 对同一 nonce 只定位一次，布局重挂载可恢复高亮而不抢阅读位置。

分支后端使用 `conversationBranch.ts` 保存每轮原始提交与原生定位：Pi 为调用前的 entry，Claude 为顶层 assistant UUID，Codex 为 turnId。产品 JSON 的 `turns` / `branch` 随原有记录写盘；列表不返回这些正文。新分支复制前缀，首次配置或发送时建立独立原生上下文，之后只续接子会话；第一轮之前为空上下文。旧记录无定位、跨引擎前缀或 Claude 前一轮未成功结束时明确拒绝。分支不回滚工作文件；附件保留路径引用，来源文件仍有保留依赖，见 `issue.md`。

现有消息按钮通过 51 行 `useMessageBranch.ts` 接入：编辑打开子会话并把原请求放回现有 Composer，重新生成走同一 `submitToPi` 管线，沿用当前角色、权限与预算。原会话草稿独立保留；准备期间禁止重复分支，切换会话后的延迟响应只保存子会话草稿，不抢导航或执行。显示层以已有 textId 标识消息，避免原生适配器各轮复用 messageId；磁盘事件不改写。分支附件为服务端路径引用，跟随 IndexedDB 草稿恢复，发送前 HEAD 检查并由主机再次验证；新上传附件仍保存真实 File。复用现有消息状态反馈，不新增编辑器或并行组件。

PDF 沿用 `filePreview.ts` / `useFilePreview.ts` 的鉴权读取、20 MiB 上限与 Blob 生命周期，在现有 Output 中交给浏览器原生阅读器。仅接受工作区文件，检查 PDF 文件头并显式使用 `application/pdf`；预览分类与 MIME 分类都识别 language=pdf，避免把 SVG 等内容交给 PDF iframe。临时 URL 不落盘，下载接口仍强制附件；浏览器不支持或显示空白时保留下载提示，兼容性证据见 [08 N 组](08-acceptance.md)。

音频/视频使用同一鉴权下载 URL 作为原生播放器的 src，不再先把整个文件读成 Blob；图片、文本、PDF 仍受 20 MiB 读取上限约束。`workspaceDownload.ts` 接管 `openWorkspaceFile` 已校验的文件描述符，按单段字节范围返回 206，非法/不可满足范围返回 416；HEAD 返回完整资源的元数据。多段范围、非 bytes 单位及无法确认版本的 If-Range 回退为普通 200，不提供强版本或不可变快照保证。流结束/取消后关闭描述符，不重新打开可变路径。响应保持 attachment/nosniff，仅音视频使用对应 MIME，其余仍为 octet-stream；no-store 与仅用于本次预览的重试参数避免复用失败响应。关闭播放器时 pause、移除 src 并 load 以取消传输，临时 URL 不写回会话。验收见 [08 R 组](08-acceptance.md)。

### 事件链路

```
Pi 原生事件 → harness/adapters/piAdapter.ts → AgentUX StandardEvent
  → runtime/eventNormalizer + admissionReport → agentmatrix/viewModel → slots/slotRegistry → 组件
```

界面上缺东西时，先查 `piAdapter.ts` 发出的事件和 `admissionReport`，不是加组件。

浏览器断线不停止服务端任务。前端共享历史加载，断线后退避重接；连续 5 次失败后停止本地等待，并提示主机任务状态尚未确认。连接握手、历史/停止请求及事件流无心跳的超时为 15 秒；正常流每 5 秒的心跳维持连接，不限制任务总时长。若 `/live` 返回 409（任务刚结束），再读落盘历史补齐尾部事件，不重放 prompt；记录中缺少本次 `requestId` 时保留用户消息并报错。停止操作收到服务端确认后才取消本地订阅。服务端启动时为没有终态的轮次补「已中断」，包括尚未产生首个 token 的轮次；沙箱暂停/恢复仍走整机快照。

从侧栏重新选择已缓存会话也会重新读取主机并订阅，不能用“已经有事件”推断缓存仍然新鲜。复用同一 followRun 入口同步占用本地订阅，重复选择和发送不会并发开启第二个订阅；纯本地空草稿不查不存在的服务端记录。连接错误及未确认提交的显示消息由 12 行 `historyFeedback.ts` 投影，不追加到真实事件数组、原生上下文或重接游标；权威历史读取成功后清除过时提示，切走后迟到的结果只更新所属会话。重新选择只读取/订阅，不重发提示词，也不代表已接入外部唤醒服务。

47 行 `runStop.ts` 集中处理停止提交：同一轮次仅保留一个在途请求，准备阶段只取消本地准备；服务端失败/15 秒超时后保留订阅，允许显式重试。现有按钮和 Composer 状态行显示提交中及“未确认主机已停止”，不覆盖草稿状态、不写会话事件或改变重接游标。控制器通过 WeakMap 绑定提交的 requestId、主机返回的 activeRunId 或实际 run.started；反馈和回执同时核对控制器与轮次，身份未知时不发送无范围停止。HTTP 与内部延迟停止均携带 runId，主机同步匹配运行槽后才停止，迟到请求不能作用于下一轮。列表/详情的 activeRunId 仅反映当时的内存状态，不保存到历史；已占槽但尚未完成引擎初始化的匹配停止仍有效。旧 API 调用省略 runId 保持兼容而不获得保护，部署须刷新页面；未占槽的未来请求不预留取消标记，见 `issue.md` #7。

`/prompt` 发出 200 响应头后被并发限制拒绝时，仍返回本次用户消息与 `run.error`，不修改已有任务的记录。已获运行槽但初始化失败的提交则将消息和错误保存，保证断线后可恢复结果。

未发送的草稿由浏览器自己的 IndexedDB `raytonebot-drafts` / `drafts` 按 conversation id 保存文字、File 和最小会话元数据。服务端记录仍是已提交轮次的权威来源；草稿仅保存请求 id 与提交快照，以便刷新后核对接收、只清掉已提交的内容。草稿不保存 provider 配置、会话 key、聊天事件或临时预览 URL；不自动发起任务。写入事务检查版本，旧标签页不能覆盖/删除另一个标签页的新草稿；存储失败时保留内存输入并反馈。限制见 `issue.md`、ADR-017。

同一记录还保存用户手选的权限模式与思考预算；接收消息后保留选项，纯选项记录不构成待发送消息。已完成历史的纯选项记录不抢占启动导航，未发送会话则可从侧栏恢复。权限优先级为会话手选、设置默认、主机默认；未手选预算为中等。恢复期间现有选项按钮暂禁用；非法权限收紧为 request。编辑／重新生成分支保存来源的有效选项，仍用原有版本检查，不另建偏好存储。

模型服务设置独立保存在当前 origin 的 localStorage `raytonebot.providerSettings`。63 行 `providerSettings.ts` 校验并保存已知服务相对项目默认值的修改，25 行 `useProviderSettings.ts` 在初始化时恢复，主机首次配置也使用恢复后的服务。仅包含地址、启用状态、模型列表/选择、默认服务与凭据环境变量名称；会话 key、协议和任意额外字段不保存，含账号密码、查询参数或片段的地址拒绝持久保存。读取失败使用项目默认值并提示，初始化不覆盖旧记录；写入失败保留当前页修改并提示未保存。其他标签页不自动切换模型，最后一次完整保存生效；不跨设备、不属于沙箱备份，见 ADR-023 与 `issue.md`。

会话列表和详情读取均有 15 秒超时；读取失败由 `historyFeedback.ts` 生成仅供显示的错误事件，复用现有错误视图，不写入会话历史、不改变重接游标。重新选择会话成功后清除提示。只有本浏览器保存的未接受草稿可把服务端 404 当作尚未创建；已保存会话的 404 明确提示历史缺失。

普通侧栏与搜索共用 110 行 `useSearchWindow.ts`，按各自的行/分组间距只挂载可见范围及焦点行；不截断元数据、存储记录或搜索结果。原按钮支持方向键、Home/End 与跨窗口 Tab；新增记录通过会话键保留阅读行与行内偏移，顶部仍显示新记录。布局计算仍为线性遍历，没有引入列表库、数据库或另一个侧栏。

审批提交共用 27 行 `approvalSubmission.ts`：现有 inline/external 控件同步阻止重复点击，提交中禁用选项，失败通过已有提示区反馈并允许手动重试。`/approval` 客户端请求超时 15 秒，超时不自动重发，也不意味着主机未接受。审批卡关闭状态以会话 id、具体 awaiting 事件 id 和工具 id 标识；迟到回执不能关闭另一个会话/轮次的审批，组件 key 沿用同一标识以隔离本地状态。不改变服务端审批策略或持久记录。

提问与两种审批表面共用 39 行 `usePromptFocus.ts`，只跟踪用户实际聚焦过的卡片。提交失败时恢复原控件；卡片卸载后，在同一会话且用户未转向其他控件时，把焦点交给后续问题标题或 Composer。新问题出现不抢焦点，问题 key 按会话/requestId 隔离；停止按钮在显式点击时聚焦输入框，不用迟到回执触发。此状态仅属于当前 DOM，不写入持久记录。

`replayIdentity.ts`（23 行）在显示回放时以 runId、实体类型和原生 id 的 JSON 元组标识工具及产物，防止跨轮合并参数、结果和文件内容。先处理用户提问过滤，再投影显示身份；原始事件、重连游标和磁盘记录不改。审批从实际 awaiting 事件找回原生工具 id 与 runId，两种现有审批入口共用这条路径；主机先检查轮次再放行 gate。接口兼容旧客户端省略 runId，但此类请求仍沿用旧匹配语义，不能防止跨轮迟到请求；部署时应刷新旧页面。已有产物标签按投影后的 id 更新，无需迁移历史或修改 vendor。

### 群聊运行保障（2026-10-06）

`groupChat.ts` 为父轮次保存 `runId`、成员当前子轮 id、订阅者和完成信号；事件复用 `conversationRecorder.ts`，按群历史连续编号，用户消息、审批/提问等待及终态落盘后再广播。已接收请求通过历史 `runId` 去重，完成与进程重启后仍拒绝重复执行；重启只补中断终态，不重放。`followRun` 同步补齐游标后的事件并注册后续订阅，断开订阅不停止运行；群成员信息随历史/搜索恢复。停止与审批先核对父轮身份，再转发当前子轮身份。成员失败使父轮失败，依赖步骤与汇总停止；并行成员全部退出后才发布唯一终态。元数据写入失败不得先发布成功，清理失败路径仍释放运行槽；群运行期间拒绝重置，群提交等待已在进行的重置，重置失败则不调用成员。

群成员通过内部 `runPrompt(..., { waitForCapacity: true, signal })` 等待已有运行槽完成；醒来后同步重查身份与名额并占槽，总上限仍为 3。等待可取消、不写子轮回执；普通网页/IM 调用仍在满额时直接拒绝，不新增 HTTP 参数或持久队列，也不承诺 FIFO。群广播逐个隔离出错的订阅者；成员失败仅发带成员名的父轮错误卡。首次元数据保存失败属于未接收，收尾与标题异常不得变为 `prompt_rejected`；错误兜底须等 recorder 收尾，避免与 `history_save_failed` 重复发布终态。

### 当前缺口

2026-10-03 已补：会话落盘与恢复、服务端模型 key（env 文件）、工作区分离、部署/备份脚本、进程重启中断标记（T3.2）。剩余：

| 缺口 | 位置 | 后果 |
| --- | --- | --- |
| 本机开发未设 `RAYTONEBOT_WORKSPACE(_ROOT)` 时 cwd = 应用目录 | `piVitePlugin.ts` | 本机 Agent 能改/删应用自身 |
| 会话 LRU 上限 12（运行中的不淘汰），并行运行上限 3 | `piHost.ts` | 单用户可接受；多用户前必须重做 |
| 外部唤醒/调度服务未接入 | `scripts/agentsphere/sandbox.py wake` | 仅有唤醒入口；调度入口待外部服务接入时再加（ADR-016），见 `issue.md` |

## 多引擎与权限（2026-10-03 新增）

`runPrompt` 按请求里的 `agentPreset` 分流：助手走 Pi，规划走 Claude Code CLI，实施走 Codex CLI。CLI 输出经 `src/pi/cliStreams.ts` 翻译成 Pi 事件，与 Pi 共用 `piAdapter`。审批闸门（`approvalGate.ts`）和权限分类（`permissionPolicy.ts`）三个引擎共用；Agent 子进程统一剥离密钥（`runtime/childEnv.ts`）。`/prompt` 新增字段 `agentPreset`、`claudeCodeModelSource`；`/state` 新增 `harnesses`、`defaultPermissionMode`。细节见 [10-agents-and-permissions.md](10-agents-and-permissions.md)。

| 新模块 | 运行位置 | 作用 |
| --- | --- | --- |
| `src/pi/harnessCatalog.ts` | 浏览器 + Node | 角色、引擎 id、设置存储 |
| `src/pi/cliStreams.ts` | 纯函数 | Claude/Codex 输出 → Pi 事件 |
| `src/pi/cliHarness.ts` | Node | 启动 CLI、stdio 审批、续接、终止 |
| `src/pi/permissionPolicy.ts`、`approvalGate.ts` | Node | 权限分类与审批等待 |
| `src/pi/runtime/process.ts`、`childEnv.ts` | Node | 进程组终止、密钥剥离 |
| `src/avatars/*` | 浏览器 | 角色头像（SVG + 动画），由 `AgentPersonaProvider` 提供 |
| `src/components/settings/*` | 浏览器 | 设置对话框（齿轮打开），文案在 `src/i18n/copy/settings.ts` |
| `src/pi/piResources.ts` | Node | Pi 会话的资源加载：禁用扩展、项目不受信任 |
| `src/pi/providerProbe.ts` | Node | `POST /provider/test`：带密钥请求服务商 `/models`，返回延迟与模型列表 |

## 目标架构（M1–M3 完成后）

```
浏览器（不变的 React UI）
   │ HTTPS + Basic Auth
   ▼
AgentSphere 沙箱
   /home/user/raytonebot/          应用代码 + dist（部署脚本覆盖，受保护路径）
   /home/user/workspace/
       agents/<角色>/              各角色 cwd
       shared/                     协作目录
   /home/user/.raytonebot/
       env                         600 权限：访问密码、模型 API key
       data/conversations/*.json   对话记录
       data/pi-sessions/<对话>/    Pi 文件会话（SessionManager.create / 按 id open）
       data/im-channels.json       600 权限：IM 频道凭据、白名单、聊天→对话绑定、Telegram 游标
       pi/                         PI_CODING_AGENT_DIR
       logs/                       runtime.jsonl + supervisor.jsonl（有界轮换、仅元数据）
   /home/raytone-agent/             Agent UID 的 Claude/Codex 原生会话；不放真实模型 key
   单个 Node 进程：静态文件 + /__agentcanvas/pi/*（T1.7 改名 /api/agent 为可选）

受信任的沙箱外主机（当前本机；外部登录 Web server 为用户确认的接入假设）
   scripts/agentsphere/deploy.py   构建 → 上传 → npm ci → 写 env → 启动 → 自检
   scripts/agentsphere/sandbox.py  create / status / wake / pause / renew / backup / restore
   backups/                        拉回 data + workspace + Claude/Codex 原生会话的 tgz
```

要点：

- **持久化用 Pi 自带的文件会话**，不引入数据库（ADR-004、ADR-012）。对话列表与历史经 `GET /conversations`、`GET /conversations/:id` 恢复。只有出现任务队列、定时任务等需求时，才考虑 `node:sqlite`（Node 22.19+ 内置，零依赖）。
- **原生上下文身份**：产品记录的 `piSessionId` 在 SDK preflight 确认 started、调用模型前写入；新记录为 null，配置失败可重试，字段缺省表示旧记录。`nativeSession.ts` 按 id 找原生文件并校验 JSONL 后打开，缺失不另起上下文；旧记录先校验目录中的原生文件，再按 SDK 列表选取最近会话，首次运行保存绑定。缓存中的 Pi 会话在配置/发送前也核对文件；这不是跨文件事务或完整语义校验。Claude/Codex 的已保存 CLI session 恢复失败同样明确报错，不自动重发到新 session。显式新建保留为独立操作。
- **保存回执**：`conversationRecorder.ts` 单独处理每轮事件写入；完整用户消息、终态与交互等待先写盘再广播，普通增量按 40 条批量写。`conversationStore.ts` 仅将 ENOENT 当作缺失；损坏记录不可覆盖，写入失败清掉未提交缓存。提交前失败保留草稿，执行中失败向已连接读者发 `history_save_failed` 并请求停止；失败回执本身不能保证落盘。刷新通过 `incomplete` 显示缺少终态，保持原事件/游标不变；重启时补中断标记失败也不阻止读取其他历史。单文件 rename 不构成跨文件事务或断电保证，见 `issue.md`。
- **凭据在服务端**：启动命令 source `~/.raytonebot/env`，模型配置用 `envVar`（默认 `DEEPSEEK_API_KEY`）取 key。浏览器设置面板保留作临时覆盖。
- **工作区分离**：云端用 `RAYTONEBOT_WORKSPACE_ROOT` 生成角色目录（见 [10](10-agents-and-permissions.md)）；本机未设置时 cwd 仍为项目目录。
- **沙箱可丢弃**：重建 = 部署脚本 + 恢复最近备份。沙箱内不放 `E2B_API_KEY`。
- **历史保留**：服务端不再以 200 个会话为界静默删历史，客户端更新也不再截断为 100 条；保留全部列表元数据，正文按需加载。只有显式删除/重置才移除产品记录；备份保留期限与外部存储策略尚未设置。
- **历史缓存**：30 行 `conversationCache.ts` 将完整摘要与最近 12 份已保存正文分开；尚未 flush 的记录单独保留，写入成功才可淘汰，失败同时移除正文/摘要缓存并重新读取已提交文件。冷列表与正文搜索仍扫描文件，热列表复用摘要；无磁盘索引、格式迁移或跨进程一致性保证。600 份约 150 MiB 正文的常驻堆增量约 3 MiB，见 [08 AP 组](08-acceptance.md)；上限按记录数，不是整台主机的字节上限。
- **进程与运行预算**：Python 标准库 supervisor 在 5 分钟内最多重启 3 次，Linux subreaper 清理遗留进程；不会在进程重启后重放任务。每轮默认 30 分钟、10 MiB 事件输出、代理最多 100 次模型请求；分别由 `RAYTONEBOT_RUN_TIMEOUT_MS`、`RAYTONEBOT_RUN_OUTPUT_BYTES`、`RAYTONEBOT_RUN_MODEL_REQUESTS` 配置。模型请求次数不是货币费用上限。
- **生产服务器**：M1 继续用 `vite preview` + 插件（已验证可用）。只有当 Vite 成为障碍（启动慢、需要自定义路由）时再换成 `node:http` 独立服务，`piHost.handle(req, res)` 已是框架无关的。

## 目录所有权

| 路径 | 所有权 | 规则 |
| --- | --- | --- |
| `src/pi/**` | 自有，主要开发区 | 服务端能力都在这里加 |
| `src/harness/adapters/piAdapter.ts` | 自有 | 事件映射问题在此修 |
| `src/agent-shell.tsx` | 自有 | 前端状态、会话恢复 |
| `src/runtime/composerDraftStore.ts`、`useComposerDrafts.ts` | 自有 | 浏览器草稿读写、事务版本检查、提交快照确认；UI 复用现有 Composer 与侧栏 |
| `src/runtime/filePreview.ts`、`mediaType.ts`、`outputframe/useFilePreview.ts` | 自有 | 文件引用、MIME 与文本/图片/PDF 的有界读取；音视频使用鉴权流，临时 URL 不写回对话 |
| `src/pi/workspaceDownload.ts` | 自有 | 已校验文件描述符的 GET/HEAD、单段 Range 与流关闭；路径边界仍由 workspaceFiles 管理 |
| `src/exported-project.ts` | 自有 | 品牌、布局、面板、默认模型 |
| `src/components/**`、`src/slots/**` | 自有，按所有者扩展 | 修缺陷，或按 AGENTS.md 白名单扩展所属组件（ADR-025）；不新增并行组件、不改 slot 布局；`slotRegistry` 必须完整 |
| `vendor/**` | 冻结的第三方构建产物（MIT） | 不改；需要改时按 [04](04-dependency-exit.md) 先迁入 |
| `src/fixtures/**`、`demo-events.ts` | 测试数据 | 只供 `?devtools=1` 和测试 |
| `src/agentmatrix/**`、`src/export/**`、`src/preview-runner/**` | 导出残留 | 不扩展；按 [04](04-dependency-exit.md) 处理 |
| `scripts/**` | 自有 | 检查与部署脚本 |

## 安全边界

- 公网入口唯一保护是 Basic Auth（≥24 字符随机密码）+ 严格 Host/Origin。不要关掉任何一层来“方便调试”。
- 审批是 UX 闸门，不是安全边界；真正的隔离来自 microVM。`auto` 模式的风险命令判断是保守的提示，不是沙箱。
- 浏览器 bundle 里不得出现任何 key；`E2B_API_KEY` 只由受信任的沙箱外脚本/服务持有（当前为本机，未来可接已有登录 Web server）。

部署脚本现在安装独立的 `raytone-agent` UID，应用 root 所有且 Agent 不可写，bot 数据/凭据由文件权限隔离。
Pi 模型循环仍在 bot 内，但全部 7 个工具在该 UID 的短命 worker 中执行；CLI 也用同一受限启动器。
模型代理位于 bot 进程内，不新增独立服务或数据库；每轮凭证限制上游、模型、次数和有效期，结束即撤销。
nftables ip/ip6 + meta skuid 按 UID 禁止直连，只开放 loopback gateway；包仓库 CONNECT 校验域名、TLS SNI 与公网 IP。
Linux 文件 API 用逐级 `O_NOFOLLOW` 的目录 fd 锚定访问；macOS 开发不声称具有这些系统隔离保证。
详细适用范围与剩余风险见 [10](10-agents-and-permissions.md)。
