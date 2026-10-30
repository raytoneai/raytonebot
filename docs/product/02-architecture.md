# 02 架构

## RSL 可选学习（2026-10-29）

`src/pi/learning/` 在现有主机内管理独立 `learning/state.json`。`GET/POST /__agentcanvas/pi/learning` 由原鉴权与 Origin 检查保护，设置保存带 revision。SettingsDialog 的开发者分区管理开关、每日预算、候选审核/停用/删除及用量。默认关闭。

普通轮次可靠结束后可入有界内存队列，空闲时用原模型服务做一次无工具分析；前台任务到来取消。批准经验可按同 Bot/引擎相关性注入后续轮次，不改变原模型、工具、审批或原生 session。坏存储只停用 RSL；队列不持久化，不重放。范围、预算与限制见 ADR-056；真实效果尚待模型对照评测。

## 登录 Vault（2026-10-25，本机实现）

`SettingsDialog` 的 Vault 分区 → `useVault` → `GET/POST/DELETE /__agentcanvas/pi/vault` → `VaultStore`。读接口仅返回条目 ID、版本、名称、精确 HTTPS origin、固定用户名掩码和启用状态；用户名/密码只接受写入，编辑留空保留，更改 origin 必须重新输入两者。保存/删除带全局 revision，冲突返回 409。浏览器输入只在表单内存中，关闭或切换分区清空。

默认文件是 `<dataDir>.vault/logins.enc`，AES-256-GCM；独立 `master.key` 或主机环境 `RAYTONEBOT_VAULT_MASTER_KEY`（64 位 hex）提供主密钥。目录 0700、文件 0600，检查所有者与链接，锁与原子替换，损坏不覆盖。本机可用 `RAYTONEBOT_VAULT_DIR` 指定测试目录；沙箱忽略该覆盖，固定使用数据目录的 sibling。普通数据备份不含该目录，恢复必须另外保管密文和匹配主密钥。工作区文件/产物/附件接口排除 Vault，子进程环境剥离主密钥；本机同 UID 不是强隔离。

`vault_request_use` 经所有引擎已有 HostTools 通道，仅接收 snapshot/ref/可选条目 ID。主机从实际页面筛选同 origin 的条目，经 `VaultRequestGate` 与现有审批卡选择已保存登录或安全输入新账号（ADR-053），任何权限模式都必须答复。秘密通过 `POST /__agentcanvas/pi/vault/requests/:requestId/answer` 直达主机；请求体为 conversationId/runId/answer，严格区分 cancel、use、fill，后者含用户选择的 save。普通 UserInputGate、问答草稿和 `/input` 不接触秘密。

120 秒一次性请求绑定 conversation/run/bot、条目版本、页面/快照/控制 epoch 和原 DOM 元素；停止、过期、编辑/停用/删除、导航/接管使其失效，保存前和执行队列内再次校验。未保存值只在本次内存路径中使用；勾选保存先原子落入 Vault 再填，后续失败报告已保存/填充未确认；落盘结果未知时不给自动重放机会。重复 POST 返回有界、只含状态的回执。事件仅含公开请求元数据与固定文案的最终回执；结果在卡片消失后仍留在聊天中。

主机直接通过私有 IPC 填入浏览器，不把值放进工具参数/结果、事件或历史。`/vault` 与专用 answer 要求自定义请求头和现有来源校验，answer 额外要求携带同源 Origin；这些是 CSRF 约束，不能抵御同 UID 本机进程伪造。设置保留永久管理入口，聊天卡片的双字段独立受控、可选保存默认关闭，草稿仅在内存；切换请求/会话、取消、成功、超时、卸载清空，迟到响应不能恢复旧输入。

首版只支持网页单聊、顶层 HTTPS 页面、普通用户名框和显式 `autocomplete=current-password` 的密码框，不支持 IM/群聊、卡号、验证码、新密码或 iframe。只填不提交；填后该文档对模型的快照/正文/标题被隐藏，下载被阻止，用户通过原有 Output 浏览器接管检查与提交。实际站点脚本必然能读到填入的值；不承诺防恶意目标站点或被攻陷主机。实现/验证边界见 [ADR-052](07-decisions.md#adr-052登录-vault-由主机保存与逐次授权填充2026-10-25) 与[验收](../../output/vault-2026-10-25/README.md)。

网页回显的秘密子串由 `browserRedaction.ts` 在主机输出边界过滤，凭据集合跨浏览器 worker 重启保留；错误文本可重复脱敏而不改坏替换标记。主机内部 URL 与元素事实保持原值供页面绑定、权限分类使用；模型结果只过滤网页名称、值、URL、标题等内容，保留生成的 snapshot/page ID、ref、角色/状态与分页协议。

## DSH 本地接入补充（2026-10-19）

创建 Bot 的现有表单可选择 `dsh`（DeepSeek Harness），原三个内置 Bot 与默认模型不变。`piHost.runCliPrompt` → `dshHarness.ts` 启动已安装的固定版本 `@deepseek-ai/dsh@0.2.1-rc.2`；`dshProtocol.ts` 将 ACP 的文本、思考、工具、审批转换成 Pi wire events，继续使用 `piAdapter` 和现有界面。ACP 此版本只推送已提交文本。

每轮创建临时 HOME / DSH_HOME / DSH_AGENTS_HOME 与受控 profile，launcher 直接调用已安装包导出的 `runProfile`，避免 CLI 自动加载个人 `.env`。真实模型 key 留在主机，子进程仅持本轮 Anthropic 兼容网关租约。关闭账号凭据、会话日志上传、PTC、子 Agent、自主后台任务与个人配置发现；所有工具经过插件的异步授权和同步 guard。

宿主 web/MCP/记忆/浏览器/计划/提问等工具通过本轮 0600 Unix socket 回到现有执行函数。主机核对原生 session、tool call id、名称和原参数，授权只消费一次。native read/write/edit/bash 由 DSH 执行，参数先归一化供既有权限规则检查。停止先发 `session/cancel`，给 DSH 清理独立进程组的命令，再由通用进程管理兜底终止。

原生会话持久化在 `<dataDir>/dsh/<conversationId>/sessions`，既有会话 JSON 的 `cliSession` 保存引擎及 id。续接失败直接报错，不换新会话；没有原生 fork checkpoint，历史分支明确拒绝。`dsh` 加入工作区、附件、文档和 Bot 配置校验；本机默认仍共用项目工作区。沙箱模式主动拒绝运行，需完成独立 Linux 隔离验收后再开放。

## 运行架构

以下描述仓库实现；部署版本和环境限制分别见 [AgentSphere 运维](06-deployment-runbook.md) 与 [AgentMatrix 部署记录](../agentmatrix-deployment.md)。带日期的补充保留其原始验证范围。

2026-10-18 sandbox 内可靠性补充（本机工作树）：`settingsFile.ts` 统一区分 ENOENT 与不可读/结构错误。记忆、MCP、例行任务和 IM 的坏文件保留并拒绝保存，设置接口返回错误；不可用的工具/时钟/连接器停用，普通聊天主机仍可启动。用户修复后重启重新读取，不自动替换为默认配置。授权和 IM 配置、映射、Telegram 游标在文件成功替换后才更新内存。

记忆 `noteFor` 现在返回说明及捕获版本的交付确认函数；附件校验先执行，Pi 的原生 preflight 接受、CLI 的原生 turn/assistant 身份确认后才提交版本。成功完成和测试 bridge 的助手事件也可确认；接受前失败不消费版本，迟到的旧确认不能抹掉新版本。

浏览器内部 IPC 的动作可携带不暴露给模型的 `downloadOwner` token；worker 按 Page/Frame 记录所属任务，在 `Browser.downloadWillBegin` 时把 token 固定进 GUID 记录，完成事件带回同一 token。host 据此找发起任务的保存回调并检查取消状态。读账号/快照/切标签不转移归属；用户接管先清页面归属，没有任务归属的手动下载不进入任意 Agent 工作区，会报告丢弃。关闭浏览器清理归属；未知 frame 同样不猜保存目标。HTTP 接口及界面结构未改变。

2026-10-18 交叉 review 补充：每个 Page 使用独立于当前截图会话的 CDP frame 观察器，后台新增 frame 也能匹配下载来源。每次修改动作使用一次性 token；页面换归属、关闭、接管或 GUID 结束后，worker 只释放已无 Page/GUID 引用的 token，host 随即删除保存回调；未接管页面的失败动作也释放。保留回调数量随活页和未完成下载变化，不随历史轮次累积。主页面快照仅因主 frame 导航失效；作用域校验识别真实 frame 元素/穿帧语法，普通名称含 frame 的容器可用。devtools 保留同一浏览器单调时钟的输入→显示延迟，移除浏览器与 sandbox 时间相减的帧年龄。fixture 的临时槽位开关经动态事件源元数据传递，产品组件不识别 fixture id。

```
浏览器  React UI（AgentCanvas 导出组件 + AgentUX 渲染）
   │  同源 HTTP（本机）/ HTTPS（云端入口）
   ▼
Node 主机（本机、AgentSphere 或 AgentMatrix）
   scripts/cloud-preview.mjs   云端入口：鉴权、Host/Origin 校验，然后交给 Vite preview
   vite dev/preview + piRuntimePlugin   前端 + /__agentcanvas/pi/* 接口
   src/pi/piHost.ts            HTTP 控制器 → Bot 身份/引擎角色 → Pi 或 CLI（DSH 仅本机）
   @earendil-works/pi-coding-agent  模型循环 + 7 个工具 + 审批闸门
   cwd = RAYTONEBOT_WORKSPACE_ROOT 下的角色目录；未设置时用 RAYTONEBOT_WORKSPACE 或应用目录
   数据 = RAYTONEBOT_DATA_DIR；默认 ~/.raytonebot/data/
```

AgentMatrix 通过 `scripts/agentmatrix/` 发布同一应用，将产品数据放在 `/workspace/.raytonebot/data`、角色目录放在 `/workspace/agents/`。首次部署仅验证应用响应与这些目录；Claude/Codex 原生会话仍在 HOME，完整恢复、浏览器依赖和 UID/网络隔离尚未补齐。入口使用 PreviewProxy 适配，不能套用 AgentSphere 的 Basic Auth 与 microVM 隔离结论。

AgentSphere 沙箱外（ADR-041，control 原型，未常驻部署）：

```
Raytone 登录 → control/（Node，常驻主机，持有 E2B key）
   /welcome 认领 → 建沙箱 → deploy.py --state-dir bots/<id> → 进度条
   「进入」→ 唤醒/续期 → 一次性令牌 → bot 的 /__raytone/handoff 换 cookie → 聊天页
   keeper（每分钟）：续期或任其暂停 · 例行任务前 90 秒唤醒 · 暂停前备份到 bots/<id>/backups
数据 = ~/.raytone-control/（store.json 无密钥；bots/<id>/access.json 存密码与交接密钥）
```

本机开发时链路相同，只是 `npm run dev` 监听 `127.0.0.1:5188`，没有 Basic Auth，由 `requestOrigin.ts` 只放行 loopback。

### 请求接口（`src/pi/piClient.ts` ↔ `src/pi/piHost.ts`）

计划更新复用既有事件存储与产物视图：Codex `turn/plan/updated`、旧 exec `todo_list`、Claude `TodoWrite` 和原生 `TaskCreate/TaskUpdate/TaskGet/TaskList` 成功回执 → 内部 `plan_update`；Pi `update_plan` 的成功工具结果也进入 `piAdapter` 的结构化 `artifact.delta` 快照。每轮一个稳定产物 id，后续完整快照替换其 data；`taskPlan.ts` 在展示时转换成 Markdown，并根据所属 run 的终态显示结束/停止/失败，不推断未完成步骤成功。打开的产物标签按 id 跟随内容更新，不按标题匹配。计划产物没有工作区路径，下载使用实际内容 Blob；没有新增 HTTP 路由或独立任务数据库，见 ADR-018。

Claude 原生任务投影另保留 task id、owner 与 blockedBy；计划模块校验边界并在既有 Markdown 产物显示负责人和仍未完成的前置任务。TaskGet 没有 owner 时保留已确认值，TaskList 为完整负责人快照；TaskUpdate 仅应用成功回执确认的字段，未知依赖 id 标记待核对，后续原生读取解除标记。TaskList 本身会过滤已完成依赖，因此这里是最近回执的展示投影，不是完整依赖图、调度器或子 Agent 状态；执行状态仍归原生任务文件所有。停止不改写原生任务为 completed。

`planTool.ts` 是 Pi 的第八个工具，仅校验并返回计划数据，不访问文件、网络或子进程；原七个 I/O 工具继续在独立 UID worker 中执行。`claudeTaskPlan.ts` 只投影原生成功回执；task id 随快照保存，续接同一 CLI session 时从最新快照初始化，冷启动不沿用。Claude 原生任务文件位于 `.claude/tasks/<session-id>/`，与 `.claude/projects` 一起备份/迁移；依赖、所有者与委派结果仍由原生 CLI 管理，当前 UI 只呈现步骤与状态。

用户提问复用现有事件存储：`run.awaiting_input` 携带唯一 requestId、toolCallId 与已校验问题；回答先写用户消息和 `tool.call.progress.inputRequestId` 并 flush，再确认 HTTP。`UserInputGate` 不读取权限模式或 always-allow；仅保留最近 100 个内存回执供同回答重试，不是持久消息队列。刷新后仅对仍活跃的等待显示控件，重启沿用会话中断终态，不恢复执行。`userInputEventsForReplay` 在真实 replay 入口隐藏已有消息所代表的工具 JSON，原始事件/游标不变。

Pi 第九个工具 `ask_user` 只等待用户，不访问文件、网络或子进程。Claude 问题先于 permission gate 分流，回答写回原生 `updatedInput.answers`；Codex 启用现有 `features.default_mode_request_user_input`，回答保留原生字符串数组，处理 `serverRequest/resolved` 撤销。控件状态由 shell 的小 hook 持有，开关 Output 不丢失；现有输入框修复回传，不新增组件。普通提问拒绝收集秘密；登录凭据走 Vault 设置或专用安全输入卡，模型 API key 走模型服务设置。`userInputDraft.ts` 使用当前标签页的 sessionStorage，按 conversationId/requestId 保存选项、自由文字和题目进度；恢复前按当前问题校验，不保存 pending/done 等提交状态，不自动发请求。表单 hook 保留内存输入并通过既有 hint 显示保存失败；观察到问题结束或收到确认时仅清理对应 requestId，迟到确认不能删除新题草稿。此数据不跨标签页／设备同步，不进入沙箱备份，关闭标签页后的保留不作保证，详见 `issue.md`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/__agentcanvas/pi/health` | 无模型调用的进程健康、活跃任务数、并发上限、运行时长与最近一次轮次距今时间（`lastRunAgoMs`，keeper 的活动识别用它，见 ADR-041）；云端仍需 Basic Auth |
| GET | `/__agentcanvas/pi/usage` | 最近轮次的主机网关用量、覆盖完整度与存储错误，不返回消息、密钥或估算费用 |
| GET / POST | `/__agentcanvas/pi/skills` | 主机文本 Skills 清单 / 保存 `{input,revision}`；冲突 409 |
| POST | `/__agentcanvas/pi/skills/remove` | 删除 `{id,revision}` 指定的文本 Skill |
| POST | `/__agentcanvas/pi/files?scope=&name=` | 单文件原始字节上传，≤10 MiB；返回 `{scope,path,name,size}`，重名不覆盖 |
| GET | `/__agentcanvas/pi/files?scope=&path=` | 当前角色或 shared 工作区的只读目录列表 |
| GET / HEAD | `/__agentcanvas/pi/files/download?scope=&path=` | 下载普通文件，支持单段 Range 与元数据读取，强制附件响应；拒绝隐藏路径、链接与越界路径 |
| GET | `/__agentcanvas/pi/state?conversationId=` | 模型、工具、会话信息 |
| POST | `/__agentcanvas/pi/config` | provider/model/thinking/会话 key；目标会话运行中返回 409 |
| POST | `/__agentcanvas/pi/prompt` | 发起一轮，返回 NDJSON 事件流；可选 `requestId` 对应该轮 `runId`，用于断线后核对提交；**连接断开不中止**，只有 `/abort` 停止 |
| POST | `/__agentcanvas/pi/group/prompt` | 群聊轮次，成员经现有 `runPrompt` 执行；群请求以已落盘事件去重，使用同一 `/live`、`/abort`、`/approval`、`/input` 接口恢复和交互 |
| POST | `/__agentcanvas/pi/group/members` | 在原会话更新成员；`conversationId`、`members`、`availableBots`、`hostId`，运行/重置中返回 409；非法成员或移除主持返回 400；合法名单可创建新会话，不调用模型 |
| GET | `/__agentcanvas/pi/conversations/:id/live?after=N` | 重新接上运行中的一轮：先补发第 N 个之后的已存事件，再推实时事件，轮次结束时关闭；未在运行返回 409 |
| POST | `/__agentcanvas/pi/abort` | 新界面传 `{conversationId,runId}`，仅停止匹配轮次；过时/已结束返回 409，非法身份返回 400；旧调用省略 runId 沿用按会话停止，空对象仍为管理用停止全部 |
| POST | `/__agentcanvas/pi/approval` | `yes` / `always` / `no`；界面携带 `conversationId`、`runId` 和原生 `toolCallId`，只匹配对应轮次；200 回执或 409 已结束后收起，同一请求同步消费一次决定 |
| GET | `/__agentcanvas/pi/approval?conversationId=…&runId=…&toolCallId=…` | 只读核对此请求是否仍待审批，返回 `{pending:boolean}`，禁止缓存；缺少身份返回 400，沿用同源校验，群聊映射回对应成员子轮 |
| POST | `/__agentcanvas/pi/input` | `{conversationId,requestId,answers}`；answers 为问题 id 到字符串数组的映射，null 明确跳过；400 校验失败，409 已失效或回答冲突 |
| POST | `/__agentcanvas/pi/session/new` | 新会话；目标单聊/群聊有运行或群委派时返回 409 |
| GET | `/__agentcanvas/pi/conversations?query=` | 对话列表（侧栏恢复）；可选 query 搜索标题和用户／助手正文，≤200 字符，返回逐消息 `matches`（片段、textId、角色、时间），保留首个 snippet/textId 兼容旧客户端，不返回全文；可选 limit=1..100/cursor 按消息分页并返回 nextCursor；`running` 和临时 `activeRunId` 标出正在运行的轮次；`unreadable` 单独列出无法读取的记录 id |
| GET / DELETE | `/__agentcanvas/pi/conversations/:id` | 读取历史事件 / 删除对话；读取错误不是 404，临时 `activeRunId` 用于恢复当前运行，`incomplete` 表示当前没有运行但已保存的最后一轮缺少终态 |
| POST | `/__agentcanvas/pi/conversations/:id/branch` | `{beforeRunId}`；201 返回独立 `conversationId` 与原始 `draft`，只保留所选轮次之前的记录，不执行草稿；来源运行中或无可靠边界返回 409 |
| POST | `/__agentcanvas/pi/provider/test` | 模型服务连通性测试 |
| GET | `/__agentcanvas/pi/channels` | IM 频道（飞书/钉钉/企业微信/Telegram）设置与连接状态；已保存的密钥只回报是否已设置 |
| POST | `/__agentcanvas/pi/channels/:platform` | 保存一个频道：`enabled`、`fields`（密钥留空保持不变）、`access`、`allowUsers`、`agentPreset`、`model`（默认模型服务定义，不含 key）；凭据或开关变化时重连 |
| GET | `/__agentcanvas/pi/routines` | 例行任务列表（ADR-033）：计划、开关、定义 revision、nextRunAt、最近 20 次 history（runId/textId/状态/时间）；模型只回报 provider/model |
| POST | `/__agentcanvas/pi/routines/:id` | `{enabled}`；或 `{title,instructions,schedule,timezone,revision}` 编辑定义，旧版本或运行中拒绝；开启时清零连续失败 |
| DELETE | `/__agentcanvas/pi/routines/:id` | 删除任务定义，保留其对话 |
| POST | `/__agentcanvas/pi/routines/:id/run` | 外部调度入口 `{occurrenceId}`：202 表示已接受、后台执行；重复 occurrence、已关闭、正在运行或并发已满 409，不排队；设置页「立即运行」用 `manual-…` |
| GET | `/__agentcanvas/pi/artifacts?query=&conversationId=&limit=&cursor=` | 注册产物元数据搜索（默认 50、最多 100 条/页）；返回来源对话、精确回放身份、事件时间、文件可用性与分页/扫描不完整标记，不返回正文。扫描上限 1000 对话、20 万事件、2000 产物；隐藏子会话、私有路径和链接被排除 |
| POST | `/__agentcanvas/pi/approvals/clear` | 清除某 Agent（`agentPreset`）或全部的「始终允许」 |

`/prompt` 可带 `attachments: [{scope,path}]`（最多 10 项）。服务端验证文件属于当前角色或共享工作区，再把绝对路径加入模型上下文；界面与保存的用户消息保留原文。上传失败保留草稿与附件，准备阶段可取消。浏览器 Output 面板复用为文件列表、目录导航及下载入口。

普通与群 `/prompt` 还可带 `referencedConversationIds`（每次提交最多五个不同的可见会话 ID）。`conversationReferences.ts` 在接收轮次前校验存在性，随 `turns` 保存；后续轮次与历史分支继承已授予的范围。引用仅让主机历史工具读取原文，不复制整份聊天进模型。Composer 的原引用入口显示选择与可移除标签，草稿、提交快照、跟进队列与分支草稿都保留这些 ID；隐藏群子会话不能被引用。

会话搜索沿用文件存储，`conversationSearch.ts` 按 runId/textId 拼接正文增量，不检索工具参数、思考或原生文件。每条命中消息返回一个片段；会话摘要保持每会话一份。`useConversationSearch.ts` 管理 200ms 防抖、取消、迟到响应及失败/部分结果，并将 matches 展开为按消息时间排序的结果；显示日期不改写会话元数据。复用既有搜索弹层、结果行与状态文字，按 conversationId/textId 联合标识，方向键与回车选择。未发送草稿保留本地标题匹配，正文请求上限 15 秒；选中结果后读取该会话并定位命中的消息。查询发现活跃会话时只订阅原任务，不重发提示词。分页用 `conversationSearchPage.ts`，服务端与客户端共用按时间降序、会话 id/textId 的稳定排序；游标绑定查询和最后一项的位置，删除游标对应消息不会让后续项跳过。新客户端每次请求 100 项并按需续页；旧客户端不传分页参数保持原返回。下一页失败保留已加载结果，关闭/换词取消全部相关请求。当前仍逐记录扫描，游标不是快照：查询期间新增的较新结果需重新查询；没有新增索引、数据库或全文下载，大量历史扫描性能和跨资源搜索仍待补。

搜索结果复用现有 SessionGroup，由 `useSearchWindow.ts` 测量可见行高度并保留上下缓冲区；未挂载行仍保留布局位置，焦点行离屏时单独保留。键盘按完整结果顺序导航，换词/关闭重置窗口，窗口宽度变化按消息标识保留阅读位置。片段不截成固定行数，不新增组件或依赖；已加载结果仍存在客户端内存，位置计算为线性扫描，不是全文索引或无限数据规模保证。

显示视图由现有 `replayAgentUXEvents` 校验/排序和 `createAgentUXViewModel` 同步派生，再用 React useMemo 缓存。避免 effect 回放让已切换会话的搜索目标命中上一会话的 DOM；没有修改 vendor 或另建回放实现。滚动 hook 对同一 nonce 只定位一次，布局重挂载可恢复高亮而不抢阅读位置。

分支后端使用 `conversationBranch.ts` 保存每轮原始提交与原生定位：Pi 为调用前的 entry，Claude 为顶层 assistant UUID，Codex 为 turnId。产品 JSON 的 `turns` / `branch` 随原有记录写盘；列表不返回这些正文。新分支复制前缀，首次配置或发送时建立独立原生上下文，之后只续接子会话；第一轮之前为空上下文。旧记录无定位、跨引擎前缀或 Claude 前一轮未成功结束时明确拒绝。分支不回滚工作文件；附件保留路径引用，来源文件仍有保留依赖，见 `issue.md`。

现有消息按钮通过 `useMessageBranch.ts` 接入：编辑打开子会话并把原请求放回现有 Composer，重新生成走同一 `submitToPi` 管线，沿用当前角色、权限与预算。原会话草稿独立保留；准备期间禁止重复分支，切换会话后的延迟响应只保存子会话草稿，不抢导航或执行。显示层以已有 textId 标识消息，避免原生适配器各轮复用 messageId；磁盘事件不改写。分支附件为服务端路径引用，跟随 IndexedDB 草稿恢复，发送前 HEAD 检查并由主机再次验证；新上传附件仍保存真实 File。复用现有消息状态反馈，不新增编辑器或并行组件。

PDF 沿用 `filePreview.ts` / `useFilePreview.ts` 的鉴权读取、20 MiB 上限与 Blob 生命周期，在现有 Output 中交给浏览器原生阅读器。仅接受工作区文件，检查 PDF 文件头并显式使用 `application/pdf`；预览分类与 MIME 分类都识别 language=pdf，避免把 SVG 等内容交给 PDF iframe。临时 URL 不落盘，下载接口仍强制附件；浏览器不支持或显示空白时保留下载提示，兼容性证据见 [08 N 组](08-acceptance.md)。

音频/视频使用同一鉴权下载 URL 作为原生播放器的 src，不再先把整个文件读成 Blob；图片、文本、PDF 仍受 20 MiB 读取上限约束。`workspaceDownload.ts` 接管 `openWorkspaceFile` 已校验的文件描述符，按单段字节范围返回 206，非法/不可满足范围返回 416；HEAD 返回完整资源的元数据。多段范围、非 bytes 单位及无法确认版本的 If-Range 回退为普通 200，不提供强版本或不可变快照保证。流结束/取消后关闭描述符，不重新打开可变路径。响应保持 attachment/nosniff，仅音视频使用对应 MIME，其余仍为 octet-stream；no-store 与仅用于本次预览的重试参数避免复用失败响应。关闭播放器时 pause、移除 src 并 load 以取消传输，临时 URL 不写回会话。验收见 [08 R 组](08-acceptance.md)。

### 事件链路

```
Pi 原生事件 → harness/adapters/piAdapter.ts → AgentUX StandardEvent
  → @agent-ux/runtime replayAgentUXEvents → @agent-ux/render-core createAgentUXViewModel
  → slots/slotRegistry → 组件
```

界面上缺东西时，先查 `piAdapter.ts` 发出的事件和回放结果，不是加组件。`runtime/eventNormalizer` 与 `admissionReport` 保留为诊断模块，不在当前 shell 的实际回放调用链上。

浏览器断线不停止服务端任务。前端共享历史加载，断线后退避重接；连续 5 次失败后停止本地等待，并提示主机任务状态尚未确认。连接握手、历史/停止请求及事件流无心跳的超时为 15 秒；正常流每 5 秒的心跳维持连接，不限制任务总时长。若 `/live` 返回 409（任务刚结束），再读落盘历史补齐尾部事件，不重放 prompt；记录中缺少本次 `requestId` 时保留用户消息并报错。停止操作收到服务端确认后才取消本地订阅。服务端启动时为没有终态的轮次补「已中断」，包括尚未产生首个 token 的轮次；沙箱暂停/恢复仍走整机快照。

从侧栏重新选择已缓存会话也会重新读取主机并订阅，不能用“已经有事件”推断缓存仍然新鲜。复用同一 followRun 入口同步占用本地订阅，重复选择和发送不会并发开启第二个订阅；纯本地空草稿不查不存在的服务端记录。连接错误及未确认提交的显示消息由 `historyFeedback.ts` 投影，不追加到真实事件数组、原生上下文或重接游标；权威历史读取成功后清除过时提示，切走后迟到的结果只更新所属会话。重新选择只读取/订阅，不重发提示词，也不代表已接入外部唤醒服务。

`runStop.ts` 集中处理停止提交：同一轮次仅保留一个在途请求，准备阶段只取消本地准备；服务端失败/15 秒超时后保留订阅，允许显式重试。现有按钮和 Composer 状态行显示提交中及“未确认主机已停止”，不覆盖草稿状态、不写会话事件或改变重接游标。控制器通过 WeakMap 绑定提交的 requestId、主机返回的 activeRunId 或实际 run.started；反馈和回执同时核对控制器与轮次，身份未知时不发送无范围停止。HTTP 与内部延迟停止均携带 runId，主机同步匹配运行槽后才停止，迟到请求不能作用于下一轮。列表/详情的 activeRunId 仅反映当时的内存状态，不保存到历史；已占槽但尚未完成引擎初始化的匹配停止仍有效。旧 API 调用省略 runId 保持兼容而不获得保护，部署须刷新页面；未占槽的未来请求不预留取消标记，见 `issue.md` #7。

`/prompt` 发出 200 响应头后被并发限制拒绝时，仍返回本次用户消息与 `run.error`，不修改已有任务的记录。已获运行槽但初始化失败的提交则将消息和错误保存，保证断线后可恢复结果。

未发送的草稿由浏览器自己的 IndexedDB `raytonebot-drafts` / `drafts` 按 conversation id 保存文字、File 和最小会话元数据。服务端记录仍是已提交轮次的权威来源；草稿仅保存请求 id 与提交快照，以便刷新后核对接收、只清掉已提交的内容。草稿不保存 provider 配置、会话 key、聊天事件或临时预览 URL；不自动发起任务。写入事务检查版本，旧标签页不能覆盖/删除另一个标签页的新草稿；存储失败时保留内存输入并反馈。限制见 `issue.md`、ADR-017。

同一记录还保存用户手选的权限模式与思考预算；接收消息后保留选项，纯选项记录不构成待发送消息。已完成历史的纯选项记录不抢占启动导航，未发送会话则可从侧栏恢复。权限优先级为会话手选、设置默认、主机默认；未手选预算为中等。恢复期间现有选项按钮暂禁用；非法权限收紧为 request。编辑／重新生成分支保存来源的有效选项，仍用原有版本检查，不另建偏好存储。

模型服务配置和凭据以主机 ProviderStore 为准（见下方 Provider 主机存储）。`providerSettings.ts` 校验已知服务的可编辑字段，`useProviderSettings.ts` 启动时读取主机；旧 localStorage `raytonebot.providerSettings` 只在主机尚无配置时作为迁移候选，显式保存后删除旧缓存。SettingsDialog 通过 `useProviderEditor.ts` 管理未提交草稿，主机写入成功后才应用；失败保留草稿，关闭时可保存或放弃。`added` 与 `enabled` 分开，停用不移除行或凭据，但禁止执行；请求携带 revision，旧页面写入返回 409 并重新读取，不再是最后写入者无条件覆盖。读取失败保留原存储并提示，不允许在未加载主机 revision 时保存。其他已打开页面不主动轮询 Provider 配置，新页面/刷新从同一主机恢复；普通数据备份不含外置私密目录，见 [12](12-provider-credentials-proposal.md)。

会话列表和详情读取均有 15 秒超时；读取失败由 `historyFeedback.ts` 生成仅供显示的错误事件，复用现有错误视图，不写入会话历史、不改变重接游标。重新选择会话成功后清除提示。只有本浏览器保存的未接受草稿可把服务端 404 当作尚未创建；已保存会话的 404 明确提示历史缺失。

2026-10-30 按用户纠正撤回 T6.8 的交付提示：聊天记录沿原标题/预览展示，不给历史终态加“新结果”等标签，也不在 Bot 下显示汇总卡片。对应的聚合、已读观察、浏览器已读存储代码及摘要 `activity` 派生均已移除。Bot 仍沿原头像行反映真实运行/审批状态；历史加载和来源导航保留原路径。

`taskRecovery.ts` 仅从错误事件及对应工具身份识别模型服务、MCP、Vault 或浏览器登录入口；助手正文不触发配置动作。`useTaskRecovery.ts` 在原聊天提供检查入口及显式继续，关闭设置不自动提交。继续前读取最新历史，拒绝运行中、缺终态、已更新或来源不可用的任务；原请求、文件和聊天引用沿已保存 turn 或尚未接受的本地提交取回。已接受轮次以新请求要求先核对进展，不重放原轮；同一来源的继续请求使用稳定身份复用主机去重，仍走现有模型和审批链路。错误识别是有限分类，不保证覆盖所有第三方错误文案。

例行任务的 `routines.json` 增加内部 `nextScheduledAt` 和可选公开 `lastSkipped:{at,detectedAt,reason}`。计时检查保存下一预期时刻，重启后可记录此前未及时检查的计划；并发占用记录 busy，均不排队或补跑。旧任务在首次检查建立基线，不推测更早历史；只保留最近一次跳过。未启动失败、重启中断与较新的跳过在原例行任务详情查看；前端仅在设置打开时刷新任务列表。

普通侧栏与搜索共用 `useSearchWindow.ts`，按各自的行/分组间距只挂载可见范围及焦点行；不截断元数据、存储记录或搜索结果。原按钮支持方向键、Home/End 与跨窗口 Tab；新增记录通过会话键保留阅读行与行内偏移，顶部仍显示新记录。布局计算仍为线性遍历，没有引入列表库、数据库或另一个侧栏。

审批提交共用 `approvalSubmission.ts`：现有 inline/external 控件只保留允许一次、始终允许、拒绝三个直接动作，无预选及二次确认；用户未点击时持续等待，不发送决定。点击后锁定首个决定，禁用重复操作并显示“正在确认你的选择”。Tab 只移动焦点，Enter/空格执行；长期授权范围在操作前持续可见。共用表单的账号选择和填答保留独立提交。POST 单次请求仍有 15 秒网络期限；回执不确定时先通过 GET 核对同一会话/轮次/工具，已处理就收起，仅明确仍待审批才重新送达原决定。查询失败按 0.5–10 秒间隔恢复，不要求用户审批重试、不重跑任务。卡片卸载或用户点击停止立即取消前端核对；刷新通过原历史/实时流恢复等待，禁止自动补发旧页面的选择。审批卡关闭状态以会话 id、具体 awaiting 事件 id 和工具 id 标识，迟到回执不能关闭别的请求。`PiApprovalGate` 在等待期间暂停 `runDeadline` 的执行计时，所有该轮模型租约共用剩余时间；批准/拒绝后按剩余预算继续，停止仍可终止等待。主机重启仍将旧运行标为中断，不伪造跨进程恢复。

提问与两种审批表面共用 `usePromptFocus.ts`，只跟踪用户实际聚焦过的卡片。提交失败时恢复原控件；卡片卸载后，在同一会话且用户未转向其他控件时，把焦点交给后续问题标题或 Composer。新问题出现不抢焦点，问题 key 按会话/requestId 隔离；停止按钮在显式点击时聚焦输入框，不用迟到回执触发。此状态仅属于当前 DOM，不写入持久记录。

`replayIdentity.ts`在显示回放时以 runId、实体类型和原生 id 的 JSON 元组标识工具及产物，防止跨轮合并参数、结果和文件内容。先处理用户提问过滤，再投影显示身份；原始事件、重连游标和磁盘记录不改。审批从实际 awaiting 事件找回原生工具 id 与 runId，两种现有审批入口共用这条路径；主机先检查轮次再放行 gate。接口兼容旧客户端省略 runId，但此类请求仍沿用旧匹配语义，不能防止跨轮迟到请求；部署时应刷新旧页面。已有产物标签按投影后的 id 更新，无需迁移历史或修改 vendor。

### 群聊运行保障（2026-10-06）

`groupChat.ts` 为父轮次保存 `runId`、成员当前子轮 id、订阅者和完成信号；事件复用 `conversationRecorder.ts`，按群历史连续编号，用户消息、审批/提问等待及终态落盘后再广播。已接收请求通过历史 `runId` 去重，完成与进程重启后仍拒绝重复执行；重启只补中断终态，不重放。`followRun` 同步补齐游标后的事件并注册后续订阅，断开订阅不停止运行；群成员信息随历史/搜索恢复。停止与审批先核对父轮身份，再转发当前子轮身份。成员失败使父轮失败，依赖步骤与汇总停止；并行成员全部退出后才发布唯一终态。元数据写入失败不得先发布成功，清理失败路径仍释放运行槽；群前台或委派运行期间拒绝重置；重置锁覆盖整个父群，先逐个重置所有所属成员和委派子会话（含已离群成员），成功后再清空父会话。群提交等待正在进行的重置，任一步失败则等待中的提交不调用成员；不承诺跨文件事务回滚。

群成员通过内部 `runPrompt(..., { waitForCapacity: true, signal })` 等待已有运行槽完成；醒来后同步重查身份与名额并占槽，总上限仍为 3。等待可取消、不写子轮回执；普通网页/IM 调用仍在满额时直接拒绝，不新增 HTTP 参数或持久队列，也不承诺 FIFO。群广播逐个隔离出错的订阅者；成员失败仅发带成员名的父轮错误卡。首次元数据保存失败属于未接收，收尾与标题异常不得变为 `prompt_rejected`；错误兜底须等 recorder 收尾，避免与 `history_save_failed` 重复发布终态。一层后台只读委派有独立任务与结果轮次，不占父群的前台运行标志，见下方 ADR-055 的委派说明。

### 当前缺口

2026-10-03 已补：会话落盘与恢复、服务端模型 key（env 文件）、工作区分离、部署/备份脚本、进程重启中断标记（T3.2）。剩余：

| 缺口 | 位置 | 后果 |
| --- | --- | --- |
| 本机开发未设 `RAYTONEBOT_WORKSPACE(_ROOT)` 时 cwd = 应用目录 | `piVitePlugin.ts` | 本机 Agent 能改/删应用自身 |
| 会话 LRU 上限 12（运行中的不淘汰），并行运行上限 3 | `piHost.ts` | 单用户可接受；多用户前必须重做 |
| 无常驻外部唤醒保障 | `src/pi/routines.ts`、`control/keeper.ts`、部署脚本 | 主机已内置计时与手动/外部运行接口；control keeper 只是原型，环境休眠期间不运行，见 ADR-036/041 与部署手册 |

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

## AgentSphere 数据布局与持久化

下图为 AgentSphere 部署路径；本机和 AgentMatrix 的路径及隔离条件不同，不是尚待实现的目标架构。

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

- **持久化用 Pi 自带的文件会话**，不引入数据库（ADR-004、ADR-012）。对话列表与历史经 `GET /conversations`、`GET /conversations/:id` 恢复；例行任务、Bot、记忆等配置也使用数据目录内的文件。队列或例行任务的存在不自动构成引入数据库的理由。
- **原生上下文身份**：产品记录的 `piSessionId` 在 SDK preflight 确认 started、调用模型前写入；新记录为 null，配置失败可重试，字段缺省表示旧记录。`nativeSession.ts` 按 id 找原生文件并校验 JSONL 后打开，缺失不另起上下文；旧记录先校验目录中的原生文件，再按 SDK 列表选取最近会话，首次运行保存绑定。缓存中的 Pi 会话在配置/发送前也核对文件；这不是跨文件事务或完整语义校验。Claude/Codex 的已保存 CLI session 恢复失败同样明确报错，不自动重发到新 session。显式新建保留为独立操作。
- **保存回执**：`conversationRecorder.ts` 单独处理每轮事件写入；完整用户消息、终态与交互等待先写盘再广播，普通增量按 40 条批量写。`conversationStore.ts` 仅将 ENOENT 当作缺失；损坏记录不可覆盖，写入失败清掉未提交缓存。提交前失败保留草稿，执行中失败向已连接读者发 `history_save_failed` 并请求停止；失败回执本身不能保证落盘。刷新通过 `incomplete` 显示缺少终态，保持原事件/游标不变；重启时补中断标记失败也不阻止读取其他历史。单文件 rename 不构成跨文件事务或断电保证，见 `issue.md`。
- **凭据在服务端**：启动命令 source `~/.raytonebot/env`，模型配置用 `envVar`（默认 `DEEPSEEK_API_KEY`）取 key。设置页通过 `/__agentcanvas/pi/providers` 保存主机配置和加密凭据；浏览器仅持未提交草稿，见 [12](12-provider-credentials-proposal.md)。
- **工作区分离**：云端用 `RAYTONEBOT_WORKSPACE_ROOT` 生成角色目录（见 [10](10-agents-and-permissions.md)）；本机未设置时 cwd 仍为项目目录。
- **沙箱可丢弃**：重建 = 部署脚本 + 恢复最近备份。沙箱内不放 `E2B_API_KEY`。
- **历史保留**：服务端不再以 200 个会话为界静默删历史，客户端更新也不再截断为 100 条；保留全部列表元数据，正文按需加载。只有显式删除/重置才移除产品记录；备份保留期限与外部存储策略尚未设置。
- **历史缓存**：`conversationCache.ts` 将完整摘要与最近 12 份已保存正文分开；尚未 flush 的记录单独保留，写入成功才可淘汰，失败同时移除正文/摘要缓存并重新读取已提交文件。冷列表与正文搜索仍扫描文件，热列表复用摘要；无磁盘索引、格式迁移或跨进程一致性保证。600 份约 150 MiB 正文的常驻堆增量约 3 MiB，见 [08 AP 组](08-acceptance.md)；上限按记录数，不是整台主机的字节上限。
- **进程与运行预算**：Python 标准库 supervisor 在 5 分钟内最多重启 3 次，Linux subreaper 清理遗留进程；不会在进程重启后重放任务。每轮默认 30 分钟执行时间（不含工具审批等待）、10 MiB 事件输出、代理最多 100 次模型请求；分别由 `RAYTONEBOT_RUN_TIMEOUT_MS`、`RAYTONEBOT_RUN_OUTPUT_BYTES`、`RAYTONEBOT_RUN_MODEL_REQUESTS` 配置。模型请求次数不是货币费用上限。
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
| `src/agentmatrix/**` | 自有的协议、图标与开发场景适配 | 保留实际消费者；旧客户端/投影器已清理，见 [04](04-dependency-exit.md) |
| `src/export/scaffoldManifest.ts`、`src/preview-runner/PreviewRunner.ts` | 类型兼容入口 | 满足穷举 registry 的类型引用，不包含旧导出/预览运行逻辑 |
| `scripts/**` | 自有 | 检查与部署脚本 |

## 安全边界

- AgentSphere 公网入口使用 Basic Auth 或 control handoff cookie，加严格 Host/Origin 校验。AgentMatrix 首期使用 PreviewProxy 入口适配，已知鉴权偏离见 [部署记录](../agentmatrix-deployment.md)；不能把它视为稳定生产鉴权已完成。
- 审批是 UX 闸门，不是操作系统隔离。AgentSphere 的 microVM、UID 与网络规则承担隔离；本机和首期 AgentMatrix 部署不具备同等边界。
- 浏览器 bundle 里不得出现任何 key；`E2B_API_KEY` / `ARIADRA_API_KEY` 只由受信任的部署脚本/服务持有。

AgentSphere 部署脚本安装独立的 `raytone-agent` UID，应用 root 所有且 Agent 不可写，bot 数据/凭据由文件权限隔离。
Pi 模型循环仍在 bot 内，但全部 7 个工具在该 UID 的短命 worker 中执行；CLI 也用同一受限启动器。
模型代理位于 bot 进程内，不新增独立服务或数据库；每轮凭证限制上游、模型、次数和有效期，结束即撤销。
nftables ip/ip6 + meta skuid 按 UID 禁止直连，只开放 loopback gateway；包仓库 CONNECT 校验域名、TLS SNI 与公网 IP。
网页搜索与读取由 bot 进程代为执行（`src/pi/webAccess.ts`，ADR-034）：Pi 原生工具、Claude Code 进程内 MCP、Codex dynamicTools，Agent 只拿到文本。
Linux 文件 API 用逐级 `O_NOFOLLOW` 的目录 fd 锚定访问；macOS 开发不声称具有这些系统隔离保证。
详细适用范围与剩余风险见 [10](10-agents-and-permissions.md)。

### 2026-10-16 Pi 运行中补充

`POST /__agentcanvas/pi/steer` 接收 `{conversationId,runId,requestId,text}`，只交给活跃的非群聊 Pi session。纯文字上限 16000 字符，不接受 `/` 命令；不越过审批或提问。回执表示已进入 SDK steering 队列，下一次模型调用前处理，不表示已经应用。请求 id 在本轮内去重；用户消息复用 adapter 与对话存储，落盘后返回成功。停止清除 SDK 待处理输入。页面错误保留草稿并沿用原 id 重试；重启不自动重发。IM 继续使用原有忙碌提示，分段输出不改变输入语义。

### 2026-10-16 审查修复补充

- **插话身份**：会话的 `activeRunId` 由事件维护 —— `run.started` 记入，`run.finished`/`run.error`（限同一 runId）清除。它此前只是读取历史时的一张快照，A 轮结束后仍留着 A 的身份，于是刷新或重连后启动的 B 轮里点「插话」会一直发给 A，被主机按旧轮次拒绝（ADR-041 之外的既有 steering 语义不变）。
- **IM 审批**：同一轮的多个 `tool.call.awaiting_approval` 全部按提问顺序保存，聊天一次只回答最早的一个，回答或结束后自动问下一个；每个工具最多提示一次（重复到达的事件不排队，回答期间到达的下一项不会在回复发送完成后再提示一次）。此前只留一个 pending，第二个覆盖第一个，被覆盖的那个工具在引擎侧一直等，IM 里再回复只会得到「上一个任务还在运行」。
- **浏览器审批与取消**：提交方法按页面实际会用的值判定 —— 按钮自身的 `formmethod`、字段按 Enter 时表单的默认提交按钮（用 `form.elements`，因此 `form="…"` 关联在表单之外的按钮也算），只有 `get` 是普通修改，`post`/`dialog` 都算对外；取数失败的元素、以及超出每次快照 200 个交互元素上限而没取数的元素都带 `unresolved` 标记，同样算对外（`enrichmentPlan` 决定读哪些、标哪些）。浏览器动作队列随所属轮次的 signal 取消，尚未派发的动作在停止后不再执行，已在执行中的一个不中断。IM 侧同一工具最多提示一次：记录最后提示的 `toolCallId`，并用有界的 `settled` 集合忽略「已经答完才到达」的重复 hold。见 ADR-040 的两条「审查修复」。
- **欢迎页认领**：`Store.claim` 一次同步 check-and-create，两个标签页同时认领只会建一个沙箱（ADR-041）。


### Bot 头像定制（2026-10-17）

现有 `SettingsDialog` 的「Bot 头像」分区为三个固定角色分别保存外观；不新增助手或 HTTP 接口。`src/runtime/botAppearance.ts` 校验枚举选项与六位十六进制颜色，`useBotAppearances.ts` 通过 `useSyncExternalStore` 订阅本页更新及跨标签页 storage 事件，存于 `raytone.bot-appearances.v1`。保存失败不应用草稿；删除某一角色配置恢复旧头像。配置只属于当前 origin / 浏览器，不随沙箱备份或跨设备同步。

`AgentAvatar` 优先使用已保存配置并调用 `botAvatarSVG`，其他入口与动画层保持共用；编辑器显式传入草稿。Shell 使用当前 `streamId` 隔离示例回放，不能使用 `isFixtureMode`：产品 `runtime.transport` 按规定保持 replay，真实对话仍通过 Pi client。

浏览器登录快捷入口（2026-10-25 更新）：Output 内现有 `BrowserView` 在浏览器未运行时提供 Google / GitHub / Reddit / Apple / X / 小红书 / 微博 / Instagram / Facebook 及「其他」入口。`POST /browser/control` 接受 `{action:"login",site:"google"|"github"|"reddit"|"apple"|"x"|"xiaohongshu"|"weibo"|"instagram"|"facebook"|"other",url?:string}`，服务端白名单映射登录 URL；other 校验 HTTP(S) URL 并拒绝内嵌凭据，出站仍经原代理，复用 takeover 与 worker open；用户直接导航无需模型审批，成员工具仍受原审批与接管互斥约束。小红书使用 `/explore` 的站内登录入口，微博使用 `/login.php`；平台风控或验证码由用户接管处理。profile 与备份路径不变，四个新增站点同时进入 `browser_accounts` 的名称与用途说明。

浏览器全局清理（2026-10-17）：`POST /browser/control` 的 `clear-logins` 操作在清理期间拒绝新的浏览器动作，等待启动/排队动作结束，关闭 Chromium 后删除当前 profile（sandbox 使用浏览器 UID）并重置 `browser.json` 的登录站点记录、快照与页面标题。现有 BrowserView 底部提供二次确认；普通关闭保留 profile。旧备份与网站端会话不受影响。

浏览器关联审批与 headed 试验（2026-10-17）：`browser.json` 保留原 origin，无需迁移；`browserPolicy.ts` 通过 PSL/private suffix 与显式账号域组识别关联登录风险，具体授权仍按 origin。测试部署的 `--headed-browser` 设置 `RAYTONEBOT_BROWSER_HEADED=1`、完整 Chromium 路径；服务端启动前缀加入私有 `xvfb-run`，worker/CDP/SSE/输出面板不换接口。普通部署仍用 headless shell，Linux 浏览器停止时原有 UID 清理同时覆盖 Xvfb。

远端输入（2026-10-17）：`/browser/input` 同时接受旧 `{input}` 与新 `{inputs:[...]}`，每批最多 64 项，整批先校验再依序执行，仍要求用户接管。前端单批在途、16ms 聚合；合并未发送的连续鼠标移动/文字/滚轮，保留按下/松开/键事件顺序，失败不自动重放；交还/关闭/离开视图清空未发送队列。截图绝对定位于画面容器，坐标使用图片实际矩形与留白换算，指针捕获避免松开事件丢失。

浏览器账号发现（2026-10-17）：Pi / Claude Code / Codex 每轮共用的模型上下文追加主机生成的浏览器说明，新增只读 `browser_accounts` 工具可在轮内刷新。数据来自既有 `browser.json.loggedIn`，使用与审批相同的 PSL/private suffix 和账号域组去重，输出站点、用途示例与 `unverified` 状态；不读取 cookie、账号身份或私有页面，不启动浏览器。记录只说明曾在用户接管期间访问，不能证明登录成功或仍有效；用户可能退出、切换账号或会话过期。Agent 使用相关会话前检查当前页面，需要登录时走原接管工具；清除后新上下文/工具结果为空，普通关闭保留候选。此说明不授予权限，也不改变服务端审批；私有内容仅在用户明确请求的任务内读取。没有新 HTTP 接口、设置页或静态 skill 文件。

浏览器工作流加固（2026-10-17）：每轮只注入有长度上限的 `browserAccountHint` 动态摘要（空清单也明确覆盖旧记录），静态规则放工具说明，完整清单仍由 `browser_accounts` 按需返回。Google 国家域名使用官方 supported_domains 的187项明确白名单，不按名称前缀推测归属；审批授权 key 仍为完整 origin。

worker 管理共享 context 中的 page/popup，自动激活新窗口，关闭回 opener；现有 BrowserView 在多页时增加标签页选择，只有用户接管时能操作。`browser_tabs` 读取/选择，`browser_wait_for` 有界等文本（至多10秒）；`browser_snapshot` 增加 `scope` CSS区域及 full/interactive/content 模式、按行分页，正文模式保留链接，未知/秘密字段不暴露值。每次快照给模型不同的 refs 前缀，内部快照ID绑定页面/版本/对话；press 显式携带结果中的 snapshotId，防旧按键审批采用新快照。动作派发前用旧ref与Playwright角色/可访问名称交集核对目标，再读提交事实；不重建整页树或修改兄弟ref。正文与带ref的链接树通过独立IPC字段传递，只改写真实树中的refs。动作后等待DOM安静200ms，最多1秒；持续变化则明确提示未收敛，较晚的异步结果仍需定向等待，不自动重放不确定动作。

接管输入批次在服务端冻结 pageId/controlEpoch，逐项检查，worker 再核 pageId。切页/交还先封住新输入和Agent动作、等待已派发输入结束；`release()` 因此为异步，所有调用必须 await。原 `/browser/control` 增加 `{action:"select-tab",pageId}`，`/browser/input` 兼容旧格式并可携带目标；新前端换目标清空队列，busy或画面页不匹配时不发输入。帧附加 pageId/seq/capturedAt，前端丢旧页/旧seq并记录 receivedAt；有界 runtime 日志仅记每批输入数量与处理时间，不记内容。关闭采用单次清理、Chrome优雅退出5秒，TERM/KILL后备总预算约8秒，服务层等待12秒；关闭期间拒绝新启动、模型动作和接管，已开始的启动完成后再关闭；SSE、首次HTTP和控制操作的返回统一检查controlEpoch。代理、UID、持久profile和审批分级保持。

### M5 第一批：群附件、工作产物与浏览器边界（2026-10-18）

- 群 HTTP prompt 与普通 prompt 共用 attachments 引用契约；新上传群文件存 shared。`groupChat` 路由后、接受消息前按所有可能的任务读取者调用现有文件校验；PM 说明和新成员介绍不传附件，摘要需要附件时校验 assistant。父轮记录附件引用；单个成员仍走原 `runPrompt` 二次验证。首条接收回执先落盘，之后保存 turn metadata，失败不会把未接受的请求 id 变成不可重试。
- IndexedDB 的现有 conversation draft metadata 增加可选 groupMembers；只有尚无历史的新群允许仅成员名单的空记录保留。正常单聊及接受后的空记录行为不变，权限仍不恢复 allow-all。
- `src/pi/artifactTool.ts` 提供 `publish_artifact`，主机验证后调用当前 adapter，走既有 artifact 事件和 OutputFrame。`resolveFilePath` 是 adapter 的可选主机回调，默认保持旧 fixture 行为；主机按各引擎 cwd 生成绝对 URI。参考 ADR-044。
- 浏览器既有 `/browser/input` 可选 inputId（仅标识符，最多64字符），SSE frame 可选同名关联。开发诊断在输入批次执行并让页面渲染后截一帧；BrowserView 解码并经过绘制帧后才记录浏览器单调时钟的 send→display 延迟，最多200样本，不保留输入内容/不落盘，普通入口不请求额外截图。capturedAt 来自 CDP 帧时间；界面不显示跨机器相减的帧年龄。
- 仅主 frame 导航使整页 ref 失效；子帧导航拒绝该帧旧目标及旧 frameRef，父页面引用保留。`browser_snapshot(frameRef, scope)` 使用快照中的 iframe 引用进入嵌套/跨域 frame；scope 不接受穿帧语法。动作按目标文档 origin 判定站点审批，按键核对实际帧焦点。切换标签不阻塞在旧 CDP detach 上，旧帧仍由 page/session/version 检查拒绝；标题读取250ms后用缓存回退。交还/最后观看连接关闭/换页清理按键，鼠标移出再释放，防止清理本身点中原按钮。
- 模型截图（2026-10-25，ADR-054）：`browser_screenshot(snapshotId)` 经原 BrowserService 返回有界视口 JPEG，HostToolResult 可携带 images；Pi/Claude/Codex 转为各自原生图片结果，DSH 复用其附件投影。用户 Output 的实时画面仍独立。截图前后核对页面/帧/秘密字段，Vault 填后隐藏、接管或停止时拒绝交付。普通远程 MCP 的图片解析不在本次范围内。


### M5 第二批：任务、表单和文本工作区（2026-10-18）

- `group.tasks` 随原会话文件保存 assignment、parentId、owner、requestId、runId、status、result、retryOf；读取时，没有本进程前台轮次或后台委派句柄的 pending/running 改为 needs_review。`/task <id> complete|cancel|retry` 是原群 prompt 内的显式控制命令，接受去重与存储约束；不自动重放。群写轮次共用串行 lease，并行讨论经 ApprovalGate 的可信 readOnly 标志拒绝非白名单工具，allow-all 也不绕过；单聊并发未改变。原工具/计划事件显示进度，不增加任务事件协议或看板。
- `.form.json` 仅接受显式 `raytone-form` v1 schema，最多20字段/24K字符，类型为 text/number/boolean/select。Output helper 使用 runtime hook 保存同源输入、稳定提交身份及封存值，提交沿 Composer 队列和主机 requestId。普通/群 prompt 可选 `artifactSubmission: {artifactId,submissionId}`，submissionId 必须等于 requestId；父 turn 保存来源，隐藏成员执行不继承父提交身份。结果按原 runId 查找并定位现有回答，脚本不参与提交。
- 既有 `/__agentcanvas/pi/files` 的 GET 支持 `query`：有预算的本地 `.md/.txt` 路径/正文搜索，返回可选 snippet、truncated。`GET /documents?scope=&path=` 返回文本、SHA256 version、可选来源；`POST /documents` 接受 scope/name/content 及可选 conversationId/artifactId，另存到 documents 唯一路径；`PUT /documents` 接受 scope/path/content/version，旧版本409，保留服务器字节。均复用同源与工作区边界；存在活动运行时拒绝 POST/PUT。
- 文件≤256 KiB、UTF-8；同一路径保存串行且原子 rename，使用 fd chmod 保留0660组权限。安全文件读取拒绝链接、私有路径及越界。来源引用随原会话 `documents` metadata（最多100项）保存，字节与 metadata 不具备跨文件事务保证；文本编辑草稿在浏览器本地，失效版本需用户明确丢弃/重新核对。新会话引用仍是原 attachments，不复制历史字节。无新服务、数据库或外部存储。

### Bot 配置与聊天归属（2026-10-27 核对）

`runtime/botProfiles.ts` 区分 Bot ID 与引擎角色：三个内置 ID 保持 assistant / planner / builder，新 Bot 使用随机 ID 并选择现有角色。名字、结构化头像、人设、模型和能力由主机 `bots.json` 持有；浏览器 `raytone.bot-profiles.v1` 仅缓存显示和未提交会话归属。旧 `raytone.bot-appearances.v1` 只用于迁移。已保存会话的 botId 在服务端记录，Bot 不接受任意 SVG。持久化接口和迁移细节见下方 ADR-049/055。

创建/编辑表单从 Settings 移到 `ShellExtras` 的唯一 `BotEditor` helper，入口为 `SessionSidebar` Logo、侧栏头像右键/键盘菜单键/编辑按钮，以及聊天标题头像右键。表单保存成功才更新；存储失败保留草稿。聊天主机使用原有 conversation ID 区分原生上下文；初版 Bot 只定制显示信息，2026-10-26 起还可保存下文的人设、模型覆盖和能力选择。Bot 仍复用所选角色的引擎、工作区与基础权限，编辑现有 Bot 不允许改引擎。

`groupParticipants.ts` 校验 `{id,name,presetId}` 名单，`group.members` 保存 Bot ID、`participants` 保存名字与引擎快照、`hostId` 保存主持。`@` 使用当前名字（支持中文）；完整头像由主机 Bot 配置恢复，历史快照不覆盖当前名字或头像。

单聊可以在原 ID 上增加 group metadata；前端历史分组和运行状态按 metadata 识别群聊，兼容旧 `group_` ID。原 transcript 保留，`group.lines` 从最近 20 条用户/助手消息初始化，每条限 4,000 字符；群内 `<conversation>.m.<botId>` 原生子会话从这个有界上下文开始，使用 Bot 的既有角色工作区和权限，不克隆原生 session。成员/署名/审批/任务负责人均用 Bot ID，执行时才映射到 preset。

普通 prompt 和 group prompt 都接受可选 `availableBots`，普通 prompt 可附 `botId`。主机仅从顶层用户消息识别明确邀请；子轮、引用、工具结果不能改成员。邀请安排主持和新成员进行一轮只读讨论后收口；菜单只更新成员，不执行模型。成员变更沿现有同源边界，运行时拒绝修改，最多八个 Bot；不新增服务、数据库或独立面板。

普通会话保存可选 `botId` / `availableBots` 快照，分支继承；HTTP 主机用 BotConfigStore 统一解析网页、IM、例行任务和群聊的当前身份，历史名单只作快照。旧数据无 botId 时按原引擎回退到对应内置 Bot。`resolveBotIdentity` 拒绝同一会话切换 Bot 或 Bot/引擎不匹配。群子轮显式提交自己的 Bot ID 和当前名单，不继承父请求的 Bot 身份。

`rolePrompt` 用当前名字生成身份与团队清单；角色只决定能力、工作区和限制。未编辑的 SOUL 模板在送给模型时替换标题，磁盘文件和用户自定义内容保留；当前配置身份优先于旧对话/人设称呼。Pi 通过 host-owned append prompt 与 SDK `setActiveToolsByName` 在下一轮刷新，保留 native session；CLI 每轮重建系统说明，模型副本附当前身份，用户原文不变。

回复语言按“用户明确指定 → 当前用户请求的语言 → 界面 `locale` 兜底”选择；只有代码、URL、附件等无法判断语言时使用兜底，无 `locale` 时参考已有会话语言或用户长期偏好。`rolePrompt.ts` 的英文规则与逐轮 `withReplyLanguage` 共用同一契约，Pi、Claude、Codex、DSH 和 Pi 插话均适用。群聊路由/分工提示使用英文；群子轮、介绍和委派保留原始用户请求作为语言依据，工具结果与主机说明不决定回复语言。FAQ 的实际菜单名跟随 `locale`，用户人设、历史与文件不翻译；语言注记仅进入模型副本，不写入产品转录。

新增产品界面文案集中在 `i18n/copy/features.ts`，英文文本作为类型化键，中文和日文必须同时提供；其余已有字典继续沿用。语音识别使用当前 `HTML_LANG[locale]`。默认群成员列表名在显示时翻译；`titleSource`（`summary` / `user`）和 `group.preserveTitle` 透传到前端，显式命名与保留的旧会话标题不翻译、不改写存储。

所有群成员共用一套路由，模型输出 `{mode,members:[稳定ID]}`；名字仅在用户输入边界解析，不决定可用模式。旧 router 的符号 route key 仅作兼容输入，映射固定内置 ID，不发入当前模型提示。重名点名拒绝猜测，前缀重叠按最长完整名字解析；PM 确认选项由计划成员生成，回答通过该轮选项表映射 ID，任务重试直接读取 owner ID。

### 服务端 Bot 配置（ADR-049/055，2026-10-26 更新）

`src/pi/botConfig.ts` 在现有主机内读写数据目录 `bots.json`（0600），保存 `{revision,profiles}`；profile 的 `id/presetId/name/appearance` 之外，可选 `role`（300 字符）、`personality`（1000）、`instructions`（4000）、`model:{provider,model}`、`mcpServerIds`、`skillIds`。`runtime/botProfiles.ts` 共用校验，缺失新字段保持旧配置有效。`GET /__agentcanvas/pi/bots` 返回完整名单，`POST` 接收 `{bot,revision}`，冲突返回 409；不可改变 ID 对应的引擎，头像仍是结构化枚举/颜色，最多 100 个 Bot。

`POST /__agentcanvas/pi/bots/import` 接收旧 `{profiles,conversations}`，只补缺失配置和未绑定且引擎一致的旧对话；不覆盖服务器保存的改名或已有 botId。`useBotProfiles` 首次导入旧名字/头像，之后读服务器，localStorage 仅为带 `source:server` 的显示缓存和未提交对话归属缓存。发送前完成同步，保存失败保留草稿；一页所有头像共享一个轮询器，前台 3 秒、聚焦及跨标签页通知刷新，未变化不重新发布状态。

HTTP host 共用一个 BotConfigStore，网页、IM、例行任务和群聊运行都按其名单解析 Bot ID。会话/群保存的 availableBots/participants 是历史快照，不再覆盖当前配置。群创建同时保存主持 botId，IM 检查已绑定会话身份以区分改名与更换 Bot。IM 设置新增可选 botId（旧 agentPreset 回退到内置 ID），频道 picker 可选全部配置 Bot；聊天配对沿用发起 Bot。Routine 新增 botId，来自创建工具所处轮次，不由模型指定；旧任务回退 assistant。每次调度都重新查当前配置，UI 用同一名字表显示所属 Bot，未配置 Bot 模型覆盖时保留入口原有模型选择，调度规则不变。

`BotEditor` 沿用原创建/编辑入口。`rolePrompt.ts` 把当前 Bot 的职责、性格和长期要求加入主机角色提示，明确优先于共享角色默认人设、服从用户当前请求；不改写历史和磁盘 SOUL 文件。已设置的 Bot 模型覆盖本轮提交的 provider/model，未设置则沿用调用入口的原模型选择。MCP 缺省 `mcpServerIds` 保持所有已启用服务的旧行为，`[]` 明确不分配；`mcpServers.toolkit` 同时在工具清单和实际调用检查当前分配与开关。`skillIds` 缺省为空。独立 Bot 配置不是独立文件系统、UID 或浏览器 profile，角色工作区和既有审批边界保持不变。

### 有范围的长期上下文与文本 Skills（ADR-055）

`memories.ts` 继续使用 `<dataDir>/memories.json`，旧记录无 scope 时视为 global；新 scope 为 `{kind:"global"}`、`{kind:"bot",id}` 或 `{kind:"group",id}`。注入、`recall_memories` 与 `forget` 只处理全局、当前 Bot、当前父群可见的记忆；模型不能自报另一个 owner ID。`remember` 单聊默认当前 Bot，群聊默认当前群，可显式选择当前可用范围；写入/删除仍走 connector 审批。Settings 原 Memory 分区负责范围选择与全局管理。总量仍为 100 条、每条 300 字符，提示有约 4000 字符预算；只读 recall 用最多 200 字符的字面查询返回最多 20 条，补查提示中省略的旧记忆。关闭后既有工具句柄也拒绝操作。

`conversationHistoryTools.ts` 直接读取 ConversationStore 的公共用户/助手文本，复用 `conversationSearch.ts` 按 `runId + textId` 累积流式内容；不读取 reasoning、工具原始内容、Vault 等专用秘密输入或引擎原生会话。`search_chat_history` 默认当前可见会话、最多 20 个命中；`read_chat_history` 用 textId/可选 runId 返回目标及合计至多十条邻居。结果保留 conversationId、角色、时间与稳定消息锚点，序列化输出最多 16000 字符，显式标注截断；越权、记录删除、歧义锚点均返回错误。跨会话范围仅来自上述用户引用，群成员与只读委派由宿主传入父群 ID，隐藏子会话即使被点名也拒绝读取。

`botSkills.ts` 将共享文本库保存在 `<dataDir>/skills.json`（0600），Settings 原 MCP 分区负责增删改、开关，BotEditor 负责分配。保存/删除带 revision，冲突 409；单条指令最多 16000 字符、总量最多 100 条、文件最多 2 MiB。模型只先收到已分配且启用的名称/说明索引（约 6000 字符），相关时用 `read_skill` 读取正文，调用时再检查最新分配与开关。内容是用户当前任务下的参考指引，不授予动作权限；不扫描个人技能目录、不加载模块或执行附带脚本。损坏记录保留并停用读取/保存，修复后重启。

### 一层只读委派（ADR-055）

`groupDelegation.ts` 只向当前群主持的普通成员轮次提供 `delegate_task({memberId,task})` 和 `group_tasks({taskId?,cancel?,offset?,limit?})`。只能选已加入的其他成员；先把 `kind:delegation` 的 assignment 存入父群 `group.tasks`，再异步启动独立隐藏子会话并立即返回任务 ID。每次请求最多四项、每群最多四项活动委派，执行复用主机总并发、容量等待、时长/输出上限。子任务带可信 `readOnly/delegated/groupId` 标志，没有委派工具；主机不提供外部 MCP、浏览器、Vault、频道/例行任务或记忆修改能力，普通写入和命令也被只读闸门拒绝。

前台群轮次正常结束不取消已接受的委派，父群可继续接收消息；新轮次保存 metadata 时按任务所有权合并最新记录。`group_tasks` 或 `/task <id> cancel` 可取消后台任务，停止来源轮次取消其仍活跃的委派，全局停止取消全部；迟到结果不能把已取消任务改回成功。主机重启后未完成项为 needs_review，不重放；委派的 `/task retry` 被拒绝，需用户核对后让主持创建新的只读任务。

完整子运行仍由 ConversationStore 保存，父任务结果最多 2000 字符并标注截断。主持用 `group_tasks({taskId,offset:0,limit:2000})` 分页读取已完成任务的公共助手正文，按 `nextOffset` 续读直至 null；只允许当前群所属任务和其 runId，不返回用户提示、推理或工具内容，取消/失败/待核对任务不能读取迟到输出。重启后仍可读取已确认完成的结果，普通聊天历史工具仍不开放隐藏子会话。完成回执在群空闲时写入独立 `result_<assignmentId>` 轮次，复用原文本和任务 artifact；不会向已结束父轮追加文本或第二个终态。回执只写一次，增加 eventCount 并更新群预览；shell 发现已选空闲群的事件数增加时刷新历史，不把后台工作标为前台忙碌。没有新服务、任务看板或嵌套调度器。

### 模型用量与 Pi 自定义参数（ADR-055）

`usage.ts` 保存 `<dataDir>/usage.json`（0600），最多 500 轮、每轮最多 100 个请求记录；身份键为 conversationId/runId，请求键来自主机网关。`runtime/modelGateway.ts` 通过 `modelUsage.ts` 被动解析 OpenAI-compatible/Anthropic JSON 或 SSE 的 usage，不改动转发字节、不保存正文或密钥；同一请求累计快照更新原记录，不重复求和，真实重试使用不同请求键。input 总量包含供应商报告的 cache 子集，不再把 cache 加一次。恢复时未结束轮次标 interrupted；存储故障保留原文件，近期数据留内存并在界面报错，不影响任务结果或重放任务。

Settings 的 Usage 分区展示可得的 input/output/cache、耗时、状态与 `source:gateway`，并区分 complete/partial/unknown。缺失字段保留未知；本机 HTTP 直连、CLI 本机登录或其他未走网关的路径可能只有未知记录，不推断零 token、价格或费用。此记录覆盖已观察到的主机模型请求，不代表供应商账单或所有后台调用。

Provider 原编辑卡可为已列出的模型配置 `modelOptions`：contextWindow、maxTokens、text/image 输入和 reasoning。`modelMetadata.ts` 在页面同步、主机保存和 Pi SDK 注册共用校验；正整数上限为 1000 万，输出不得超过上下文，输入须包含 text。未配置保持旧默认（128000 上下文、16384 输出、text/image，reasoning 沿原端点能力判断）；只缩小上下文时默认输出同步取较小值。配置随既有 Provider 主机存储保存，不新增定价猜测或更换产品默认模型，不宣称改写 CLI 的原生模型目录。


### Provider 主机存储（2026-10-23）

保存接口在读取请求体后、同步落盘与缓存失效前再次检查活跃任务，避免请求期间启动的新任务被销毁 bridge。Composer 的可选模型菜单经 `ShellExtras.providerSelection` 一次提交 Provider ID 和模型；原 slot registry 和独立预览回调保持兼容。

主机在配置、执行（应用 Bot 覆盖后）和凭据解析时复核已保存的启用状态，旧快照不能重新启用服务；停用保留密钥，显式模型列表探测仍允许。Claude/DSH 的 Anthropic 地址转换只适用于官方 DeepSeek 根地址或 `/v1`，自定义 OpenAI-compatible 地址拒绝推断；显式 Anthropic 服务保留自定义地址，避免凭据跨 endpoint。

单聊的顶栏、可选 Composer 模型菜单与提交共用 `botModelConfiguration`：Bot 覆盖优先，否则继承全局服务或 CLI 本机登录偏好；覆盖不存在/停用时明确报错，不静默回退。有覆盖时菜单保存 Bot 配置及 revision，不改变全局默认；修改 CLI 来源需先在 Bot 编辑器清除覆盖。发送使用本次主机 Bot 同步返回的配置，避免 React 旧闭包继续显示/提交上一版本。群路由使用入口全局服务，各成员执行时应用自己的覆盖。

`src/pi/providerStore.ts` 在 `<dataDir>.provider-secrets/` 持有加密的配置与 endpoint 绑定凭据；主机 GET/POST `/__agentcanvas/pi/providers` 返回 revision 与非秘密状态，POST 显式更新/删除，运行中拒绝保存。主机持久化先于页面应用，所有引擎共享解析。IM/例行任务通过 `credentialSource: "host"` 排除网页临时 key。此目录位于 data 备份之外，同时加入 Agent 工具与工作区读取排除；本地 master.key 或外部 RAYTONEBOT_CREDENTIAL_MASTER_KEY 的恢复边界见 [12](12-provider-credentials-proposal.md)。
