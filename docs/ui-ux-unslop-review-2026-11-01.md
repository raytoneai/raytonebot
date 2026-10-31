# RaytoneBot UI、UX 与注释审查

审查日期：2026-11-01（Asia/Shanghai）。代码基线：`3c19a33` 加当前工作区；未修改已有运行时代码或未提交改动。

后续修正：用户授权三个子代理实施、主代理 review 后，以下 8 项已在基于 `c8f1f77` 的独立分支 `codex/unslop-ui-fixes` 完成；[改动、验证与边界](../output/unslop-fixes-2026-11-01/README.md)。下文保留初次审查时的证据和限制，不代表修正后的现状。

结论：**已检查的主界面属于轻度视觉 slop，主要问题集中在文案的信息层级、少数交互细节和注释的准确性。适合局部修整。** 中性表面、紧凑侧栏和三位 Bot 的角色头像已经形成辨识度，应该保留。

方法参考 Damir Sokolovsky 的 [unslop](https://github.com/heydamir/unslop/tree/4652254daff586ff4739849395a127b56f7f8cc7)，重点采用其 [审查清单](https://github.com/heydamir/unslop/blob/4652254daff586ff4739849395a127b56f7f8cc7/skills/unslop/references/signs.md) 中的文案、视觉层级和一致性原则。原方法为 CC BY 4.0；下述源码与交互判断来自本项目检查。注释审查是本轮补充，不是 unslop 自带的静态规则。

## 优先处理的发现

P2 表示值得修正的可用性或维护准确性问题；P3 表示局部打磨。这里没有据此认定的 P0/P1 问题。

### 1. P2：普通错误优先展示开发者信息

- **证据**：[ChatFrame.tsx](../src/components/agent-preview/ChatFrame.tsx) 第 455–475 行；[exported-project.ts](../src/exported-project.ts) 第 336–339 行。默认 `errorCollapse: false`，非特殊 incident 的标题回退为 `item.code`，正文优先用 `developerMessage`。
- **实际观察**：`?devtools=1` → `Error block` 显示 `E_WRITE_FILE` 和 `EACCES: permission denied, open /repo/src/SearchInput.tsx`。该 [fixture](../src/fixtures/agentux/block-error.events.jsonl) 已有 `userMessage: "Could not write the generated file."`，却没有优先展示。
- **影响**：用户得到错误码和路径，却要自己推断失败的操作与下一步。终态、重试等分类已有可读标题，普通错误的完成度落后于同一界面的其他状态。
- **建议**：在现有错误分支优先显示操作结果和 `userMessage`，技术细节收进原有详情区域。例如已知写入权限错误可显示“无法保存文件”，补充“请检查目标目录的写入权限”。未知错误保留原文详情，不编造原因或自动重试。
- **验证边界**：已复现展示逻辑；未制造真实文件写入失败，也不代表所有线上错误都走此分支。

### 2. P2：窄屏设置的当前分类会落在视口外

- **证据**：[SettingsDialog.tsx](../src/components/settings/SettingsDialog.tsx) 第 130–168 行；[settings.css](../src/components/settings/settings.css) 第 556–560 行。
- **实际观察**：桌面进入“开发者模式”后切换到 390 × 844，11 个分类变成横向导航。导航可视宽度为 357px、内容宽度为 1065px；选中项位于 x=881–997px，可视区域为 x=16.5–373.5px。内容标题正确，但当前导航项不可见。页面本身没有横向溢出。
- **影响**：导航能滚动不等于当前位置清楚。较后的分类难发现，切换尺寸后也看不到选中项。
- **建议**：先在既有导航中保证打开指定分类、分类变化和断点变化时，选中项进入可视区域；必要时在窄屏复用现有 SelectMenu 表达当前分类。保持 SettingsDialog 所有权，不新增设置面板。
- **验证边界**：复现的是桌面切窄屏路径；未将其扩大为所有手机访问路径都会失败。

### 3. P2：设置文案把说明书和实现边界挤在操作旁

- **证据**：[LearningSection.tsx](../src/components/settings/LearningSection.tsx) 第 13–24 行；[features.ts](../src/i18n/copy/features.ts) 第 441–495 行；[settings.ts](../src/i18n/copy/settings.ts) 第 349 行；[vault.ts](../src/i18n/copy/vault.ts) 第 13 行。
- **实际观察**：“自学习（RSL）”下面连续解释引擎、代码、人设、用户记忆、候选审核、原生会话、干净基线、UTC、输入字符、输出 tokens、账单和队列恢复。390px 下，两个关闭的开关周围仍有多段说明。模型设置在本机入口也常驻“销毁后新建沙箱需恢复私有存储”；中文导航保留“Vault”。
- **影响**：名称的能力暗示较大，用户必须读后续限制才能理解实际只是提取、审核和复用文字经验。技术信息与当前操作同等显著，阅读成本偏高。
- **建议**：名称直接描述行为；成本、审核和停用后果仍明确可见。更深的实现说明按上下文展开，沙箱恢复提示只在相应环境或帮助中出现。

| 当前表达 | 建议方向 |
| --- | --- |
| 自学习（RSL） | 任务复盘与经验复用 |
| 启用后台学习 | 自动整理任务经验 |
| 不会修改引擎、代码、人设或用户记忆…… | 从已完成任务中整理经验，经你审核后供后续任务参考。启用会额外调用模型。 |
| 停用不清除原生会话已看到的内容，恢复干净基线请新建对话 | 停用后，当前对话可能仍受已使用经验影响；新建对话可避开这部分影响 |
| Vault | 登录凭据；需要时在说明中保留 Vault 名称 |
| 已有产物元数据，但未输出可预览内容 | 暂无可预览内容；有可用文件时提供原有下载入口 |

这些是文案方向，实施时应同步中英日字典。开发者页面可以保留技术信息；问题在于信息层级，不是出现缩写本身。

### 4. P2：部分通用控件的无障碍名称仍硬编码为英文

- **证据**：[ToolCallCard.tsx](../src/components/agent-preview/ToolCallCard.tsx) 第 139 行的 `Collapse tool` / `Expand tool`；[OutputPanelModal.tsx](../src/components/agent-preview/outputframe/OutputPanelModal.tsx) 第 74 行的 `Close output`；[OutputTabs.tsx](../src/components/agent-preview/outputframe/OutputTabs.tsx) 第 39 行的 `Opened output`。
- **实际观察**：中文 `Tool approval` 场景的辅助功能树直接读出 `Collapse tool` / `Expand tool`。另外两处由源码确认，未单独完成弹层与多标签读屏验证。
- **影响**：视觉上已经本地化的操作，读屏时仍切换语言；与相邻的“展开输出”“关闭文件”等控件不一致。
- **建议**：沿现有 `useCopy()` 和字典补齐标签，不新建翻译体系。不要把 fixture 里的英文任务标题、代码或用户内容算作界面漏译。

### 5. P3：欢迎页主要靠通用问候承担内容

- **证据**：[composer.ts](../src/i18n/copy/composer.ts) 第 181–184 行；[agent-shell.tsx](../src/agent-shell.tsx) 第 1368–1372 行；[ComposerFrame.tsx](../src/components/agent-preview/ComposerFrame.tsx) 第 424–429 行。
- **实际观察**：默认页面的主要标题是“今天想让我帮你做些什么？”。当前 Bot 的能力主要由侧栏的 Pi / Claude Code / Codex CLI 引擎名表达。
- **影响**：熟悉产品的单用户仍能直接输入，但标题没有提供具体起点。换成任何助手品牌也成立，是本轮最明确的模板化文案。
- **建议**：保留头像和居中输入框，只将问候改得更具体，例如 Raer 可用“让 Raer 查资料、处理文件或整理思路”。自建 Bot 应由自己的职责决定，不统一套口号。不需要新增一排功能卡或恢复已撤回的状态汇总。
- **注意**：[exported-project.ts](../src/exported-project.ts) 第 23–31 行虽然有另一组 headline、supportingText、suggestedPrompts，当前实见欢迎页取的是角色 greeting。修改配置前应先确认实际渲染路径。

### 6. P2：注释中有失效调用关系和不完整的运行环境前提

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| [OutputFrame.tsx](../src/components/agent-preview/OutputFrame.tsx) 第 26–28 行 | 声称 App、ToolCallCard、ChatFrame 从此导入，且 scaffold export 对路径作断言；当前没有 `src/App.tsx`，现存类型调用方仍有 ToolCallCard、ChatFrame、ArtifactLaunch | 保留兼容性重导出，注释只写当前调用关系；删除失效的导出器依据 |
| [SessionSidebar.tsx](../src/components/agent-preview/SessionSidebar.tsx) 第 22–25 行 | 仍说 sidebar 配置由 Sidebar preset group 编辑，指向已退役的配置器体验 | 写清现有会话列表职责及 `project.sidebar` 对可见项的控制 |
| [app.css](../src/styles/app.css) 第 8535–8538 行 | 声称媒体预览会播放 2–3 秒 spinner 再显示 demo asset；当前 [mediaPreviews.tsx](../src/components/agent-preview/outputframe/mediaPreviews.tsx) 直接使用真实 src 和原生媒体元素，没有该定时演示过程 | 改成当前媒体容器布局约束 |
| [permissionPolicy.ts](../src/pi/permissionPolicy.ts) 第 7–19 行 | 总述直接假设 RaytoneBot 运行于 disposable microVM；实际支持本机，网络分类也取决于 `policy.egressContained` | 明确本机与隔离环境的区别，围绕实际策略字段说明条件 |

这类注释比单纯啰嗦更值得先修：后续维护者可能依据错误前提改变行为。这里指出的是文字准确性问题，没有据此认定运行时权限存在漏洞。

### 7. P3：部分注释像设计辩论或变更日志

- [ComposerFrame.tsx](../src/components/agent-preview/ComposerFrame.tsx) 第 25–35 行用一整段解释“三种而不是两种”，包含“every shipping agent client offers”“unguarded mode”式的泛化论证。它还将二元选择描述为“每次读文件都确认”，并非本项目当前 `request` 模式的精确说明。建议压成“模式按宽松程度排序；主机执行实际审批，危险样式仅标记 allow-all”，权限细节链接到现有文档。
- [SettingsDialog.tsx](../src/components/settings/SettingsDialog.tsx) 第 44–50 行、[ShellExtras.tsx](../src/components/shell/ShellExtras.tsx) 第 37–44 行反复提及 magpie、CC Switch、OpenDots、nightly openbot 等设计来源。来源记录可以保留在既有决策文档；组件注释应优先说明状态归属、草稿保存与兼容约束。
- [openedItemBody.tsx](../src/components/agent-preview/outputframe/openedItemBody.tsx) 第 28–30、51–56 行两次复述过去生成假预览的经过。可合并为“空正文显示空状态；只有包含 HTML 标记的正文才渲染页面，其他内容显示源码”。保留防止假预览的约束。
- [shell.ts](../src/i18n/copy/shell.ts) 第 101、136 行的“used to be inline ternaries”“previous inline branch”属于迁移叙述，对当前行为帮助很小。

判断标准：优先留下代码本身看不出的原因、条件、兼容关系和安全约束；删除自我评价、无来源的普遍断言和重复历史。不能按注释长度批量删除。

### 8. P3：已有设计 token，但局部字体规则仍各自取值

- **证据**：[app.css](../src/styles/app.css) 第 52–56 行定义了语义字重；[settings.css](../src/components/settings/settings.css) 第 41–60、95–99、127–130 行仍分别使用 700、560、650，16px/18px 标题有 `-0.01em` 字距；[app.css](../src/styles/app.css) 第 4487–4492 行标题为 760。
- **实际观察**：开发场景“编码 Agent”标题计算样式为 16px、760；侧栏“Agent”为 12px、650。主界面实际字体是 IBM Plex 系列，不能因为根 CSS 有 Inter 回退值就判定“默认 Inter 模板”。
- **影响**：视觉上只是轻微不一致，但新区域继续手写字重，会削弱现有 token 的约束作用。
- **建议**：触及相关区域时复用已有语义 token，先处理小字号标题的负字距和同级标题字重。不机械要求全部变成 400/500，也不按所有奇数像素报错；2px 微调和对齐补偿可以有合理原因。

## 次要残留与明确保留项

`src/i18n/copy/shell.ts` 仍有 AgentCanvas、UX Presets、UI/UX saved 等旧配置器字典；`composer.ts` 保留 `floatingSettings`。本轮未找到这些分支的实际消费点。它们是可进一步核对的维护残留，**不是已确认出现在产品里的脏文案**。清理前应查动态取键、类型依赖和兼容范围。

以下不列为 slop：

- 角色头像和品牌黄色：承担身份识别，与单用户多 Bot 场景相关。不能把所有角色插画都当作通用 AI 装饰删除。
- 等待审批的三种选择及“始终允许”的范围说明：对应真实授权结果，应保留准确语义。
- 正在执行、思考和加载时的动画：是否多余要按活跃状态判断。搜索到 `infinite`、`gradient` 不足以证明当前界面有装饰滥用。
- 多数源码注释中的 run identity、草稿恢复、并发读写、事件本地化和焦点约束：这些信息解释了不明显的实现原因。
- 既有中性主题、默认关闭的输出面板、紧凑会话列表：符合工作工具的使用方式，继续沿用。

## 建议方向与顺序

产品：在个人工作区里，交给不同 Bot 执行任务、处理审批和查看产物。

性格：安静、明确、略带亲和力。

场景：日常工作台；聊天和文件是主要内容。

视觉重点：保留 Bot 头像及真实产物预览；导航和设置保持中性。

识别细节：沿用已有角色头像，不再增加装饰徽章或循环动效。

建议先修 1、2、4 的交互与表达问题，再处理 6 的失真注释；随后做 3、5、7 的文案精简，最后随相关改动统一 8 的局部样式。全部沿用现有 owner，不需要新组件体系、后端或依赖。

## 检查范围与限制

- 阅读产品定义、当前进度、开发约束及相关源码；核对文案的消费路径，避免把旧字典、备用样式和 fixture 内容误报为当前产品问题。
- 使用临时独立的服务端数据与工作区目录运行 Vite。正式检查入口为 `http://localhost:5188/`，避免原 `127.0.0.1` 浏览器缓存的历史会话干扰。
- 实看默认欢迎页、模型服务设置和 390 × 844 的开发者设置；另通过实际 DOM/辅助功能树检查 MCP 与 Skills、记忆、审批、错误及产物场景。共检查三个代表性 fixture，不宣称完成全部 20 个场景回归。
- 浏览器返回的日志包含另一入口的旧 HMR 错误，未将其算成本轮新增缺陷，也不据此宣称浏览器全程无错误。
- 未调用真实模型、连接外部账号、保存凭据、改变权限或部署；未做深色主题、日文界面、真机触摸或完整读屏验收。
- 本轮仅增加审查文档。核对源文件与相对链接并执行空白检查；没有运行 build/test，因为没有修改运行时代码。
