# Open issues

Last updated 2026-10-04. Each issue records what was verified, what is unknown, and the options.
Platform facts come from probes against `api.agentsphere.run` with throwaway sandboxes.

**当前开发前提：**sandbox 暂由外部常驻服务（如 bot 注册／登录 Web server）负责唤醒，
该服务尚未接入；持久化问题保持 open。暂停快照不等于永久存储，实例丢失最多恢复至最近
可用的实例外备份。具体问题、假设和上线前待决项见下方「持久化问题与当前假设」。

## 1. No long-lived sandbox on AgentSphere: lifetime is at most 50 hours per window

**Status:** open, platform limitation. External-service wake is the working assumption as of
2026-10-04; no external service has been connected or deployed.

Verified:

- One run window is at most **50 hours**. Asking for more is rejected at creation
  (`Timeout cannot be greater than 50 hours`) and silently capped when renewing.
- There is no "never expire" value. Omitting `timeout` gives 15 s; `timeout: 0` expires at once;
  a negative value is rejected.
- Renewing (`POST /sandboxes/{id}/timeout` or SDK `set_timeout`) resets the end to *now* + up to
  50 h. It can be repeated.
- A sandbox created with `{"autoPause": true, "autoResume": {"enabled": true}}` **pauses** at
  its timeout instead of being destroyed. Resume (`POST /sandboxes/{id}/resume`) takes ~1.2 s and
  restores everything (same PIDs, tmpfs, files, ports, URL). This lifecycle can only be set at
  creation; existing sandboxes cannot be changed.
- The platform proxy does **not** wake a paused sandbox when its URL is opened: it answers 502.

Unknown (not testable without waiting days, or not documented):

- Whether the total lifetime is capped (renewing past 50 h since creation was not tested).
- How long a paused sandbox is retained before deletion.
- Recovery: the platform runs on a single host with `SANDBOX_RECOVERY_ENABLED=false`.

The current instance is recorded in the untracked `.agentsphere/deployment.json`; it uses auto-pause. Wake it with
`scripts/agentsphere/sandbox.py wake`; back up with `sandbox.py backup`.

### 持久化问题与当前假设（2026-10-04）

**状态：部分实现，问题保持 open。** 实例丢失时，恢复上限是最近一份可用的独立备份；
备份之后新增的记录和文件可能丢失，没有可用备份时不保证恢复。外部唤醒入口接通也不改变
这个数据丢失边界。外部存储、备份与保留策略确定并完成恢复验收前，不承诺零丢失或自动恢复。

**实施前提：**以应用文件与独立备份作为恢复边界；先假设 sandbox 由外部常驻服务唤醒，
例如负责 bot 注册／登录的 Web server。这是接入假设，不表示该服务已经存在或完成接入；
具体服务与接口待定。接通唤醒不代表已有永久存储、异地备份或任务恢复，以下未决项保留为独立问题。
用户已确认的是外部服务承担唤醒的分工；平台保留期限、独立存储可用性、自动备份和恢复时限
仍是未验证或待决定事项，不能因继续开发而视为已确认。

**正式上线前的待决与验收项（不阻塞按上述假设开发）：**

- [ ] 外部服务的接入位置，以及用户／bot／sandbox 映射的持久保存方式；当前仅按该服务存在来设计入口。
- [ ] 外部入口是跳转到各 bot 的独立 origin，还是同域代理多个 bot；若共用 origin，浏览器草稿和
  设置须先按用户／bot 隔离，并验证账号或 bot 切换不会恢复另一方的数据。当前不假设登录服务会自动完成这种隔离。
- [ ] 实例外备份存放位置、执行周期、保留期限与失败告警；当前本机归档不等于已上线的备份服务。
- [ ] 可接受的数据丢失窗口（RPO）与恢复时间（RTO）；确定前不承诺零丢失、永久保存或自动恢复。
- [ ] 在最终部署环境完成销毁后重建的恢复演练，同时核对产品记录、三引擎原生上下文、分支来源和工作文件。

**按故障场景区分恢复能力：**

| 场景 | 数据恢复边界 | 任务与唤醒假设 |
| --- | --- | --- |
| 浏览器刷新或断线 | 从服务端重新读取已保存会话；本地草稿遵循下述浏览器存储限制 | 服务端任务可继续；重新连接不自动重发原请求 |
| 应用进程重启 | 恢复磁盘上的会话、原生上下文与工作文件 | 未完成轮次标为中断，不自动重放业务动作 |
| sandbox 暂停后唤醒 | 已实测同一实例的整机快照恢复；保留期限仍未知 | 暂停期间不执行任务；假设外部服务鉴权后调用 resume 并等待 health 就绪 |
| sandbox 销毁、丢失或平台故障 | 只有实例外仍可读取的独立备份可用于重建；最多恢复至该备份时点 | 重新部署、恢复数据并注入凭据；唤醒接口不能代替重建，执行结果不明的动作不自动重试 |

**已验证的范围：**

- 产品对话、CLI session id、Pi 原生上下文保存到 `~/.raytonebot/data`；工作文件保存到
  `/home/user/workspace`。刷新或服务重启可以恢复已落盘记录。
- 备份包含上述数据以及旧/新 Agent HOME 下 Claude Code 的 `.claude/projects`、`.claude/tasks`、Codex 的
  `.codex/sessions`。2026-10-04 新 UID 方案已另做跨实例恢复，核对原生 session id、输出文件和
  bot/Agent 所有权；三个引擎均无工具复述原口令。旧归档兼容路径保留；恢复前校验归档并停止
  写入进程，恢复失败回滚。这证明应用数据可迁移，不证明平台永久保留或灾难恢复能力。
- 暂停/恢复是平台整机快照；它与“备份后重建”是两条不同的恢复路径。进程重启会把未完成轮次
  标为中断，不自动重放可能已经执行过的写入或对外操作。

**仍未解决或未作保证：**

- 沙箱磁盘和暂停快照都不等于永久存储；暂停保留时长、平台故障后的可恢复性仍未知。
  当前也没有独立于平台的持久卷保证。
- 产品聊天记录与引擎原生上下文是两份数据；侧栏和历史可读，不代表模型仍能续接原会话。
  恢复验收须同时核对产品记录、原生 session 与工作文件，不能只恢复 conversation JSON 或 session id。
  当前工作树已让 Claude/Codex 在原生会话找不到时明确失败，不再自动另起上下文重试；Pi 改为保存并
  精确恢复 native session id，文件缺失或 JSONL 无法完整解析时拒绝继续。首次配置失败允许修正后重试；
  无绑定的旧记录仅从可读原生文件迁移，不用界面历史拼造模型上下文。缺文件时仍须恢复数据或明确
  新建对话；保护不等于数据已找回，旧记录仅有错误且从未生成原生文件时也可能需要新建，见 W 组验收。
- 会话分支须同时保存原始请求、每轮原生定位信息和来源关系；当前工作树已接通后端和现有编辑／重新生成
  按钮（Y 组）。子会话首次建立原生上下文前仍依赖来源文件，继承轮次的定位也可能引用原生
  来源，备份／清理不能只按当前会话 id 删除文件。旧记录缺少定位时应明确拒绝，不能从显示文本重造
  上下文。分支不回滚已写工作文件或外部动作；附件只保存文件引用，不保证保留当时的文件字节。
  分支及来源数据的完整归档、保留策略与跨实例恢复仍须单独验收。
  编辑带回的附件以服务端引用保存在浏览器草稿中；发送前做 HEAD 检查，主机再校验路径与权限。
  文件缺失时保留草稿并报错，不自动删附件继续执行；检查不锁定文件，也不保证原始字节未被修改。
  分支响应丢失时服务端可能已保存一个子记录，客户端不会自动再建或执行；应先查看侧栏并核对状态。
- “记录已落盘”和“用户能找回记录”须分别验收：前端曾在更新会话时只保留 100 条元数据，
  导致旧记录仍在磁盘上，却从侧栏与搜索中消失。当前工作树已移除该截断；历史读取失败应明确
  提示并保留草稿，不能当作空历史或删除记录。该修复不增加平台存储保留保证。
  现有搜索入口已支持标题和正文、片段与消息定位（Z 组）；搜索复用应用记录和运行中缓存，不另存
  一份索引，也不能用“能搜到”证明流式尾部已写盘或原生上下文仍完整。
- 文件损坏或读取失败不能当作“会话不存在”，否则续问可能覆盖原记录；写入失败也不能在缓存中
  冒充保存成功。当前工作树已有拒绝覆盖、保留正常历史并报告读取异常、写成功后更新元数据缓存的
  防护及回归用例；桌面/390px 浏览器已验读取失败、写入失败与恢复后显式重试（V 组），未部署生产，
  也不代表损坏文件已自动修复。
- HTTP 200、流连接建立或看到增量文字，都不等于整轮已持久保存。当前工作树在完整用户消息、
  终态和交互等待等关键事件广播前写盘，其余流式事件仍按批次写入；进程异常退出可能丢失尚未
  flush 的尾部。临时文件加 rename 只保护单份 JSON 的替换，不是断电持久性保证（未做 fsync），
  也不是产品事件、引擎原生上下文与工作文件之间的事务。已用不可写临时文件路径注入提交前、流式
  中途、终态写入失败；这不等于真实磁盘耗尽、断电或文件系统故障的压力验收。
- 执行中保存失败的错误本身也可能无法落盘。当前向已连接读者发错误并请求停止；刷新后用只读
  `incomplete` 标记提示“已不在运行，但记录缺少结束状态”，重启补中断标记失败也保留此提示。
  已经产生的文件或外部副作用不会回滚；先核对结果再决定是否重试，不能从缺少终态推断没有执行。
- 当前存储假设一个应用进程独占数据目录；内存缓存不会持续检测外部文件修改。尚未提供跨进程
  写锁或冲突合并，不能让多个应用实例同时写同一目录；备份恢复和人工修复须先停写，再重启读取。
  工作树已将完整摘要与最多 12 份已保存正文分开缓存；未写盘记录不会因浏览/搜索被淘汰，保存失败
  清除未提交缓存。它只限制正文缓存数量，不提高持久性，也不是总内存字节上限；冷列表和正文搜索
  仍扫描文件。600 份历史的内存与真实 SDK 刷新验收见 AP 组，未部署生产。
- `backups/` 只是运行脚本那台主机上的归档，不能据此声称已有异地备份或备份服务。
  外部存储位置、备份频率、保留期限、容量告警、可接受的数据丢失窗口（RPO）与恢复时间（RTO）待定。
- 活跃任务期间的数据一致性不能由一次文件打包保证；定时备份应跳过忙碌实例，恢复必须停写。
  备份检查与新任务启动之间仍需协调，不能把“检查时空闲”称为全局一致快照。
- 模型 key、访问密码、E2B key 不属于数据归档。新实例恢复需要由受信任的部署环境重新注入配置
  与凭据；恢复聊天记录不会自动恢复登录凭据或外部服务集成。
- 定时任务不会在暂停中的沙箱自行执行。恢复中断的业务动作也不能仅凭进程重启或唤醒自动重试；
  不确定的提交须查询结果或明确标记状态未确认。
- 未发送的文字与附件现在按会话写入此浏览器的 IndexedDB；显示“草稿已保存”后可刷新恢复，未发送
  对话也可从侧栏找回。请求 id 用于核对服务端已接收的提交，刷新不会自动重发；停止保留后续草稿。
  这是浏览器本地数据，不在沙箱备份里，也不跨浏览器/设备同步。浏览器清理、私密模式、空间回收和
  尚未完成的写入仍可能丢失；失败与跨标签页版本冲突会显示提示，保留内存中的输入，不冒充保存成功。
  实测包含真实附件恢复后上传的字节核对；浏览器崩溃、存储被驱逐与大容量草稿未做压力验收。
  当前单用户、每个 bot 独立 origin 的边界不变；未来多个 bot 共用外部服务同一 origin 时须按用户/bot
  隔离本地草稿，不能直接沿用当前键空间。清空文字并移除附件后，若没有手选运行选项则删除对应
  草稿；有手选选项则保留选项记录，不影响服务端聊天记录。
- Composer 手选的权限模式与思考预算已随会话保存到现有浏览器 IndexedDB，复用草稿版本冲突检查；
  优先级保持“会话手选 > 设置默认 > 主机默认”，未选择的预算仍为中等。已接受消息只清理文本与
  附件，不清除手选选项；空草稿也可保存选项。编辑／重新生成分支继承来源会话当时使用的选项。
  本机真实 Pi SDK、刷新、空草稿、双标签页冲突与 390px 浏览器已验，见 AI 组；未部署生产。
  此记录不跨设备、不属于沙箱备份，刷新前保存失败或冲突仍不能承诺恢复；不自动启动任务，普通
  新会话不把未手选的默认配置存为永久覆盖。非法持久化权限回退为请求审批，不扩大权限。
- 模型服务设置的恢复在当前工作树中使用浏览器 localStorage：仅保存用户相对项目默认值修改的服务地址、启用状态、
  模型列表/选择、默认服务和凭据环境变量名称；会话 API key 不写入，带用户信息、查询参数或 fragment
  的地址不持久保存。此设置不跨设备、不在沙箱备份内，同一 origin 的最后一次完整保存生效，其他标签
  页不自动切换当前模型。读取/写入失败须明确提示，不能声称保存成功；不改变项目的默认模型。
  当前键空间以每个 bot 独立 origin 为前提；浏览器清理或更换 origin 会失去这些覆盖设置，需重新配置，
  不能依靠恢复沙箱备份找回。
  本机刷新、读取/写入失败、实际 SDK 请求与桌面/390px 已验，见 AQ 组；尚未部署生产，浏览器驱逐、
  多标签页覆盖及跨设备恢复未作验收或保证。
- 外部任务的 occurrence 去重记录保存在调用主机的私有磁盘，并不在沙箱数据归档内。当前文件锁
  只协调同一主机；部署外部服务时须保证这份状态持久化，多实例调度须接其已有共享任务存储。
- CLI 计划快照随服务端会话事件保存、备份与恢复；刷新读取已保存步骤，不自动执行或续跑计划。
  负责人、前置任务等原生任务信息也沿用该快照，不另建任务库；它们只表示最近已确认的回执，
  未确认的依赖变更须待原生读取核对，不代表已启动委派或具备跨进程调度能力。
  步骤状态仅反映引擎报告，停止/失败不会把剩余步骤标成完成。它还不是具备依赖、调度与委派的
  持久任务系统；进程重启后的计划终态复用会话中断事件。
  Claude 新任务的原生状态另存在 `.claude/tasks/<session-id>/`，不能只恢复聊天记录；已纳入旧/新
  HOME 的备份及 UID 迁移路径。本机已验证任务文件归档往返、主机进程重启后的真实 CLI 续接和 task id
  关联；2026-10-04 新 SDK 的云端跨实例恢复另核对了任务文件哈希、session id 与属主，并由真实
  Claude CLI / DeepSeek 按原 task id 更新为 completed，磁盘状态与产品事件一致。Pi 的 `update_plan`
  保存在原生上下文与产品事件中。这些验收不代表任务会在暂停或实例丢失期间继续执行。

- 用户提问及已提交回答随服务端会话事件保存、备份；刷新可重新回答仍在运行的待答问题，主机重启则标中断，不自动续跑。尚未提交的选项、文本与题目进度保存在当前标签页的 sessionStorage；存储成功后刷新重选同一待答问题可恢复，不自动提交。关闭标签页、浏览器清理或存储不可用时不保证保留，不跨标签页／设备同步，不属于沙箱备份；读取或写入失败会提示并继续允许手动回答。新的 request id 不继承旧答案；当前页面看到问题结束或收到提交确认时清理对应草稿，其他页面结束而本页未观察到时可能保留至标签页关闭或下一次提问覆盖。最近 100 个提交确认回执仅在主机内存中去重，重启后以已保存历史为准，不能自动重放答案或任务；它不是持久任务收件箱。

**唤醒假设与接入约定：**

- 用户已确认的前提：暂按外部常驻服务负责唤醒，例如负责 bot 注册、登录的 Web server；
  不假定该服务已经部署。本轮不在 Mac 上安装常驻唤醒服务，也不新增一套账号系统。
  具体主机、域名和登录集成尚未提供。

以下是当前实现约定，实际外部服务接入时仍需核对：

- 外部服务先完成用户鉴权与 bot 归属校验，再调用平台 resume，等待受保护的 health 接口就绪，
  然后把用户转到 bot。直接打开已暂停沙箱的原 URL 仍可能返回 502，直到前置入口接通。
- 外部服务接入时须持久保存用户与 bot 的归属、bot 对应的 sandbox id／部署信息、备份位置和任务
  去重记录；这些状态不能只放在待唤醒的沙箱内。当前脚本从调用主机的私有状态目录读取部署信息，
  尚未接入外部注册／登录服务的数据存储；实例重建后还须更新映射，不能继续把旧 id 当作可唤醒实例。
- 唤醒仅适用于平台仍保留的暂停实例；已销毁或无法恢复的实例须重新部署并恢复独立备份。
  外部登录服务的存在本身不代表已有备份、持久卷或故障恢复能力。
- E2B 凭据只能由受信任的沙箱外服务持有，不能发给浏览器、模型或 Agent 沙箱。外部服务上的凭据
  存储与轮换方式在接入该服务时确定；现有 bot 的 Basic Auth 继续有效。
- 外部调度器负责定时唤醒、触发任务和备份。先提供可调用的脚本/接口与去重状态，再接实际调度器；
  未连接调度器不等于已启用自动备份或无人值守任务。
- 暂停期间不承诺可访问，也不承诺任务按时执行。若要求严格准点或持续运行，外部服务还需负责
  到期前续期、运行状态监测和失败告警；这些不能由沙箱内进程守护替代。

验收依据：`docs/product/08-acceptance.md` B、D 组要求及 F、G、P、Q 组实测记录，与
`03-roadmap.md` 的 2026-10-04 恢复演练记录。
以上平台事实沿用已记录的探测结果，本次文档更新没有重新探测保留期或平台灾难恢复。

Earlier options (external-service wake above is now the working assumption):

1. **Accept pause + wake on demand** (current). Costs nothing while idle. Needs a manual `wake`
   (1 s) when the URL returns 502. Agent tasks cannot run while paused.
2. **Keep-alive renewal from outside the sandbox.** Run `sandbox.py renew` every ~24 h from a
   scheduler that holds the E2B key, for example a launchd job on this Mac (stops when the Mac is
   off) or a small always-on host or CI cron. The E2B key must not go into the sandbox
   (ADR-006). Needs a decision on where the key may live.
3. **Wake-on-access front door.** A tiny always-on proxy outside the sandbox that calls `resume`
   before forwarding, so opening the URL wakes the bot. Needs a host for the proxy and the key.
4. **Ask the platform team** for one of: a longer or unlimited timeout, auto-resume in the proxy,
   a documented paused-retention period, or persistent volumes. This would remove the workarounds.
5. **Move to a VM or VPS** for always-on operation. This contradicts the cost goal.

## 2. Providers without a Responses API cannot drive Codex directly

**Status:** partly solved.

Codex 0.153+ speaks only the OpenAI Responses API (`wire_api = "chat"` was removed). It now runs
on DeepSeek with an API key and **no Codex login**: DeepSeek serves `/v1/responses` natively,
verified on this Mac and in the cloud sandbox. The current worktree uses Codex `app-server`
with per-action approval. Configured HTTPS providers use the bot's model gateway: Codex receives
a revocable per-run token, while the real provider key stays in the bot process. This does not
translate APIs; the upstream must still implement Responses. Production has not yet received
these changes.

Open: providers that serve only Chat Completions (check before enabling: Kimi/Moonshot, Z.ai,
OpenRouter, local runtimes) still cannot run Codex. Option: run a Responses↔Chat translating
gateway next to the bot, as magpie does. This was verified on this Mac: a headless
`magpie serve` (MIT, built from source with `-tags nogui`) relays both endpoints. The cost is a
37 MB Go binary and one more process in the sandbox. Do it only when such a provider is needed.

## 3. Bot / Agent isolation requires the new deployment setup

**Status:** implemented in the worktree and verified in isolated Linux instances, including
three-engine tasks and cross-instance restore. Not deployed to production, which still uses
the earlier shared-user architecture.

The new setup runs CLI engines and all seven Pi tools as `raytone-agent`, protects bot secrets
and application files with native ownership, and restricts Agent network access with IPv4/IPv6
UID rules. Codex uses native per-action approvals; configured model requests use bot-held keys
and bounded temporary tokens. Deployment fails if the required isolation cannot be installed.

Limits: the three roles share one Agent UID, macOS development has no equivalent hard boundary,
and the HTTPS package allowlist is not a data-loss prevention system. The external wake service,
offsite backup storage and retention policy remain unconnected. See
`docs/product/10-agents-and-permissions.md` and the verification record in `08-acceptance.md`.

## 4. Claude / DeepSeek may include protocol markers in the final answer

**Status:** open; observed once in the isolated cloud user-question check on 2026-10-04.
Claude Code 2.1.267 with the configured `deepseek-flash` completed the requested file, but its
final answer ended with DSML closing markers. The same text exists in the native Claude session
transcript, before the product's event adapter. The file and successful terminal were verified;
this does not make the response presentation correct.

Reproduce and locate the provider/CLI boundary before fixing it. Do not globally strip matching
text from messages: a user may legitimately ask to display protocol examples. See U group in
`docs/product/08-acceptance.md`; no provider or model switch has been made.


## 5. Reused tool ids merge tool cards across turns

**Status:** fixed in the worktree; not deployed. Reproduced with the actual Pi SDK and a loopback OpenAI-compatible model on
2026-10-04. Two runs in one conversation returned the same native tool-call id. The second
run's awaiting-approval card appeared in the first run's timeline position and retained the
first run's denied result. The new approval still appeared, and stopping it did not write the file.

The 23-line `replayIdentity.ts` scopes tool and artifact display identities by run; raw saved
events and native approval ids remain unchanged. Approval submission includes the run id, and
the host rejects a stale run before resolving the native gate. Older clients omitting run id
retain the prior matching behavior and do not gain this protection; refresh the UI when deploying.

AG acceptance verifies five actual SDK turns sharing one native id: denial, two independent
file outputs, a missing-file error and cancellation. Desktop/390px, refresh/reselect, separate
output tabs and stale HTTP approval rejection passed; 117 tests, build and local checks passed.
No vendor, UI component or history migration was required. Claude/Codex live browser approval
and production rollout were not repeated for this module.

## 6. Embedded browser cannot display PDF pages through the native reader

**Status:** open; a standalone parsing prototype works, but is not integrated into the product.
On 2026-10-04 the same valid two-page PDF stayed blank in iframe, embed and object in the
Codex in-app browser. Changing the HTML embedding element does not fix this client boundary.
Chrome native rendering was previously verified (N acceptance).

A temporary, locally served PDF.js 6.4.299 prototype displayed both pages and actual text at
desktop/390px widths, reported malformed structure and recovered after replacing the file.
Its core, worker, viewer and CSS total 754,550 gzip bytes before optional fonts/CMaps/Wasm.
Do not add these to initial chat loading or replace working native controls without preserving
their reading/navigation behavior. Project manifests and production components are unchanged.

Proposed integration: reuse the existing Output/download/retry/modal lifecycle, load parsing
only on PDF open, and isolate rendering/cancellation in a small module. Page/zoom controls
would extend existing components; that scope is awaiting the user's answer to the AGENTS.md
restriction. Large/complex PDFs, font/codec assets, password handling, text selection and
teardown in the actual app still need acceptance. See AH in `docs/product/08-acceptance.md`.

AO follow-up verified that the embedded client's ordinary Chrome user agent, PDF plugin list
and `pdfViewerEnabled: true` cannot distinguish its blank native reader. The standalone proposal
now exercises page navigation, zoom, text copying, malformed-file retry and close/reopen at
390px. Product integration remains pending: the concrete scope in `docs/product/11-parity.md`
adds controls only inside the existing Output view, lazy-loads the parser and retains a native
reader option. No product dependency or component was changed by this prototype.

## 7. Delayed stop requests could cancel a later run

**Status:** fixed in the worktree; not deployed. Reproduced on 2026-10-04 with a real Pi SDK
task: holding the browser's stop request until a replacement run started cancelled that new run.
This differs from a delayed response, which the local controller guard already handled.

New-client stops carry conversationId and runId. The host rejects a mismatched or ended run with
409 without stopping another task; malformed identities return 400. List/detail responses expose
transient activeRunId for refresh recovery, and internal deferred stops also capture their run.
Unknown client identity produces visible failure rather than an unscoped request. An accepted
slot can be stopped before engine startup; a request arriving before any slot exists gets 409,
not a cancellation promise for a future submission.

Legacy requests omitting runId retain their previous behavior and do not gain this protection;
refresh old pages when deploying. An explicit empty body still supports administrative stop-all.
125 tests, build, local checks and actual desktop/390px browser stop/refresh/draft checks passed;
the replacement task remained active after the old request arrived. See AM acceptance. No cloud
rollout or new Claude/Codex live stop verification was performed.

## 8. Reopening cached history did not retry a disconnected run

**Status:** fixed in the worktree; not deployed. A real browser exhausted five reconnect
attempts while the host task remained active. Restoring connectivity and selecting the same
sidebar row made no history or live request because its transcript was already cached.

Selecting a cached conversation now shares the existing history/subscription path; an active
subscription is reused. Connection failures and unconfirmed message notices are display-only,
so they do not advance the host event cursor or claim a persisted terminal. Successful reads
remove stale feedback; drafts remain separate, and reconnect never resubmits a prompt.

AN acceptance covers continuing/completed host runs, delayed reads across conversations, a new
run started during an old read, and undelivered-message recovery at 390px. 126 tests, build,
local checks and 18 existing browser scenarios passed. This does not wake a paused sandbox or
provide recovery for missing server data; the external-service and backup assumptions above remain.
