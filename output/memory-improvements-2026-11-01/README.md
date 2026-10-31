# T6.10 记忆可靠性分批验收

用户授权按优先级实施，subagent 负责代码，主代理独立 review、验证并逐批提交。起点 `1162313`；不修改真实用户记忆、模型或权限，不推送或部署。

## 第一批：可靠读取

- `recall_memories` 增加可选 cursor/nextCursor，最多 20 条/页。游标绑定持久版本、规范化查询和 Bot/群范围；变化后明确报过期，重新从第一页读取。43 条匹配跨三页无遗漏/重复；跨范围、无效及过期游标不返回数据。
- 提示和查询按更新时间排序。编辑条目移到保存序列末尾；时间重复或回退时仍优先，重启保持稳定。长列表的旧条目修改后进入约 4000 字符提示。
- 成功的 Pi compaction_end、Claude compact_boundary、Codex contextCompaction/thread-compacted、DSH compaction/end 使当前范围投递失效。显式原生重置清当前会话所有范围。旧投递回执不能确认新状态；下一用户轮次补发一次，之后恢复仅变化时发送。
- CLI 边界使用主机内部事件，不进入 UI adapter。DSH 沿既有私有 socket 通知，核对活动 session，flush 等待回执。未改原生 SDK、审批或模型。

主代理审查补充：编辑同毫秒/回退时的排序、会话重置的全部范围、失败重置不失效、关闭/清空后的忽略提示、压缩后迟到的接受回执。没有每轮重复注入全部记忆。

验证：

- `node --test src/pi/memories.test.ts`：18/18 通过。
- `npm run build`：通过，保留既有 chunk 大小提示。
- `npm test`：748 项，747 通过、1 项安装环境相关 DSH 跳过、0 失败。
- `node output/memory-improvements-2026-11-01/check-local.mjs`：创建临时目录/随机端口运行既有 `npm run check:local`，通过并清理；无模型请求。
- `node scripts/cloud-preview.mjs --check`、`git diff --check`：通过。

日志：`batch1-memory-tests.log`、`batch1-build.log`、`batch1-tests.log`、`batch1-local-check.log`、`batch1-cloud-check.log`。

限制：未用真实外部模型构造长对话压缩，不承诺同一轮内自动重试已经补回记忆；旧 Codex 原生线程保留原 dynamic tool schema，新增工具参数可能需新建会话后才可见。本批无 UI/事件投影改动，未重复视觉验收。提交：`1617adb`。

## 第二批：内容维护

- `remember` 可带 replaceId/expectedText 原位替换，保留 ID/范围/创建信息；越范围 ID 与不存在 ID 同样拒绝，过时原文不覆盖，满容量仍能替换。原 connector 授权策略不变，没有新增强制审批。新建和修改都拒绝同范围相同文本；不自动合并/删除另一条。
- 可选 evidence 记录 HTTP(S) URL 和真实日历格式的核对日期。旧数据兼容；不抓取网页、不自动填今天、不把记录日期称为主机核验。替换默认清旧证据；设置可保留/清除，网址变化清旧日期。
- Memory 原分区增改来源，安全链接、三语标签。轮询后旧编辑提交 409 并保留草稿；未编辑证据时不回写旧值。主代理截图 review 补暗色链接对比和窄屏输入宽度；没有并行面板。
- 新增可选 `docs/task-skills/memory-audit.md`，在用户请求下完整分页、按主题列疑似冲突和理由，授权后才改并回读。通过现有 Skills 服务字段校验；此批仅保存仓库文本，尚未安装到真实 Bot。

验证：25 项记忆测试、14 项客户端测试、11 项设置浏览器测试通过。主代理 build、隔离 check:local 和 `memory-browser-review.mjs` 通过，覆盖真实 API 下的新增/清除证据、并发文本改写拒绝和草稿保留；en/zh/ja 的桌面亮色与 390px 暗色截图已查看。`fixture-browser-check.mjs` 复用上一批已有脚本，在隔离数据里检查欢迎页及 19 个事件场景、桌面/窄屏，全部通过。

完整回归首次为 757 项：755 通过、1 项 DSH 跳过、1 项既有浏览器 popup click stalled。未修改浏览器代码或测试超时，单项复跑通过；再次默认并发 `npm test` 为 756 通过、1 跳过、0 失败。首次失败和复跑分别保存在 `batch2-tests.log`、`batch2-popup-recheck.log`、`batch2-tests-recheck.log`；不宣称该间歇超时已经解决。

限制：expectedText 校验文本，不是整条记录的历史版本控制；没有语义冲突自动判定、时效事实强制联网或真实模型质量对测。项目交接与导出见后续批次。提交：`13bbf0f`。

## 第三批：项目交接

- `docs/task-skills/project-handoff.md` 是现有应用可保存的文本 Skill。显式持续项目才维护一份已知路径的 `PROJECT.md`，完整读取并保留用户内容，记录目标、状态证据、选择/否决理由、下一步与未决问题。只有保存和回读核对后才登记交付版本，无变化跳过。
- 主代理 review 核对路径不硬编码、当前指令/权限优先、读取失败不覆盖、并发版本保护按工具能力表述，以及文件保存和产物登记失败分别报告。没有新增产品运行时代码或界面。
- 两条新 Skill（记忆审计、项目交接）通过原服务保存并分配给本机 Raer，重载 `read_skill` 可读。原文件先备份，逐项确认既有 Skills、其他 Bot、Raer 模型/权限等字段不变；安装 ID、配置版本和回退文件位置见 [local-skill-install.json](local-skill-install.json)。未改真实用户记忆或同步到云。

验证：`node output/memory-improvements-2026-11-01/project-handoff-check.mjs` 在临时工作区使用现有文档 API、真实主机产物登记和受控执行器，5 组检查通过。两会话/三轮经过服务重载，保留 USER_KEEP、用户并发修改和选择/否决理由；旧版本写入返回 409；无变化时调用方跳过写入/登记；源文件变化后重载版本库，两份交付字节与原哈希一致。字段、文档链接及 `git diff --check` 通过。本批无产品代码变化，未重复构建/全量测试。

限制：受控流程没有模型或网络调用，不证明真实模型会读取或遵循 Skill，也不证明文档语义正确。无变化跳过是本次调用方行为，不是新主机强制规则。结果见 [project-handoff-check.json](project-handoff-check.json)。提交：`53638bc`。

## 第四批：主机导出与恢复

- `scripts/memory-backup.mjs` 要求显式源/目标路径，导出原始 `memories.json`、转义后的可读 Markdown 和固定文件名的清单；恢复先核对结构、长度、SHA-256 和记忆字段，再原样写入新目录。`memories.ts` 只将现有校验器改成可复用的未知输入守卫，没有第二套记忆规则。
- 两种目标都必须不存在，不提供覆盖选项。成功文件 0600、目录 0700，回读核对并写入最后的结果记录；失败非零退出，清理只处理仍由当前操作创建的文件，保留并发新增/替换的内容。CLI 不输出记忆正文。运行命令和限制见[架构文档](../../docs/product/02-architecture.md#主机记忆导出与恢复t610)。
- 主代理 review 发现 TextDecoder 默认去掉 UTF-8 BOM 与原应用 JSON 读取行为不一致，修正为共同拒绝并补回归；同时核对固定文件名、共享条数校验、数值时间保留、写失败结果和清理身份。没有新增 UI、HTTP 路由、Agent 工具、依赖或自动调度。

验证：`node --test src/pi/memories.test.ts src/pi/memoryBackup.test.ts` 共 33 项通过；新增 8 组覆盖不同换行/缩进的逐字节恢复、启用/关闭与所有范围、来源/核对日期、冷启动查询、CLI、私有权限、缺文件/损坏/哈希/元数据拒绝、BOM/大小/链接/FIFO 拒绝、写失败和并发替换清理。`npm run build` 通过，保留已有大 chunk 提示。日志见 `batch4-memory-tests.log`、`batch4-build.log`。

主代理完整回归首次为 765 项：763 通过、1 项 DSH 环境跳过、1 项既有 popup click stalled（与第二批同项）。无代码变动的单项复跑 1/1 通过，再次默认并发 `npm test` 为 764 通过、1 跳过、0 失败。分别保留 `batch4-tests.log`、`batch4-popup-recheck.log`、`batch4-tests-recheck.log`；不宣称该间歇超时已解决。文档来源、命令、相对链接及 `git diff --check` 通过。

限制：只在临时数据中验证，没有导出或覆盖真实用户记忆；恢复需目标主机停止，只写新目录，不自动切换现有服务。清单校验不是签名认证，本机副本不是异地备份。没有调用真实模型、启用外部调度、Git 推送或云部署；既有 AgentSphere 完整备份与 AgentMatrix 待验范围不变。本批无界面/事件投影或 HTTP/云入口变化，不重复第三批之前已通过的视觉及入口检查。
