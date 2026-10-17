# Browser use 方案与 RaytoneBot 优化调研（2026-10-17）

调研阶段只读官方文档、仓库源码与 LICENSE，没有安装候选项目或运行横向基准。下文的“当前实现”指实施前版本；后续落地见文末。以下“支持”表示项目当前文档/源码提供该能力，不表示已在 AgentSphere 上验证。网站登录成功率、耗时、token 节省比例不能由这些资料直接推出。

## 结论

RaytoneBot 已有 Playwright/CDP、真实 Chromium、持久 profile、用户接管和服务端审批，建议保留这条链路。最值得借鉴的是 **agent-browser 的页面输出与 refs 设计、Playwright 的页面/弹窗生命周期、Stagehand 的先观察再执行与定向提取**。先补浏览器工具的可靠性，比再接一套自主浏览器 Agent 更直接。

这是根据下文资料和当前实现作出的工程判断，不是候选项目实测排名。

## 项目对照

| 项目 | 已核查的能力与定位 | 嵌入现有应用的边界 | 本项目建议 |
| --- | --- | --- | --- |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | 开源 Python Agent 库，可选择模型、本地/云浏览器；`Browser(cdp_url=...)` 可连已有浏览器。 | 引入完整 Agent 会增加一层决策循环；Python 库不等于 TS Playwright 的替代包。 | 参考 DOM 表示和任务验收；暂不接完整 Agent。 |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | 面向 Agent 的 CLI；当前原生 Rust daemon，支持 CDP、紧凑快照、refs 与实时预览。 | 可以作为受限子进程，但其 CLI 还有 eval/cookies/network 等广泛权限，不能把整套命令直接交给模型。当前不是一个必须依赖 Playwright 的 TS wrapper。 | 最值得借鉴输出格式、refs 生命周期、等待指引。 |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 基于结构化 accessibility snapshot 的 MCP；持久 profile、外连 CDP、tabs、可选 capabilities。 | 接入 MCP 后仍要让每个动作经过本项目审批和浏览器控制权规则；多出一个工具面和生命周期管理者。 | 用作 Playwright 生态的行为参考，现阶段没有必要并行安装。 |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | `observe` 产生动作、`act` 执行、`extract` 按 schema 提取。当前主线/文档已是 v4。 | v4 明确没有 Playwright Page 互操作；可连 CDP，但原流程要移植。不能根据旧 v3 示例认定它是现有 Page 的附加层。 | 借鉴观察/执行分离和定向提取，暂不换驱动。 |

表中来源：[Browser Use 入口](https://github.com/browser-use/browser-use#which-browser-use-do-i-need)、[Browser 参数](https://docs.browser-use.com/open-source/customize/browser/all-parameters)、[agent-browser README](https://github.com/vercel-labs/agent-browser#requirements)、[Playwright MCP 配置](https://github.com/microsoft/playwright-mcp#configuration)、[Stagehand v4 迁移边界](https://docs.stagehand.dev/v4/migrations/playwright)。

## 可以直接借鉴的五项

### 1. 先处理新窗口和 OAuth popup

当前 [`browserWorker.ts`](../src/pi/browser/browserWorker.ts) 启动后只保存 `context.pages()[0]`，监听当前 page 的导航、加载和对话框，没有处理 `context.on('page')`/`page.on('popup')`。因此网站打开新窗口时，用户可能仍在看旧页，Agent 也拿不到新页快照。

Playwright 官方区分 `BrowserContext` 的新 page 事件与某个 page 的 popup 事件，并展示在点击前准备等待事件的方式；Playwright MCP 提供 list/create/close/select tabs。[Playwright Pages](https://playwright.dev/docs/pages)、[MCP tabs](https://github.com/microsoft/playwright-mcp#tab-management)。

**建议**：在现有 worker 维护 page ID 和活动页，首先覆盖用户登录产生的 popup；活动页切换时，更新截图来源、URL、对话框处理和 refs。关闭登录窗口后回到发起页。所有新页继续使用原 context/profile、代理和审批；弹窗创建或切页不代表自动批准 OAuth 授权。

**验收**：自建无账号 popup fixture，验证打开、显示、输入、关闭和回原页；另测 popup 导航后旧 refs 被拒绝。真实账号授权仅由用户接管。

### 2. 页面输出先变短，再考虑增量

当前 worker 每次 summary 都采集完整 `ariaSnapshot({mode:'ai'})`，并对最多 200 个候选 refs 读取审批事实；service 将返回文本按 8,000/15,000 字符截断，靠 offset 读后续。字符分页有用，但没有先针对任务缩小内容，也可能在结构中间截断。[当前 worker](../src/pi/browser/browserWorker.ts)、[当前 service](../src/pi/browser/browserService.ts)。

agent-browser 官方提供 interactive-only、compact、depth、scope 等快照选项。其官方 docs 同时说明可用带 ref 标注的截图补充视觉信息。[Snapshots](https://agent-browser.dev/snapshots)。当前 main README 另宣称 `snapshot --delta` 保存 baseline 后返回 full/unchanged/增量，命令解析器也已接受 `--delta/--full`；详细 Snapshots 文档尚未列出它，本次未运行验证。该 API 与对两个快照做比较的 `diff snapshot` 不是同一入口，因此不把自动增量列为首轮必做项。[README snapshot options](https://github.com/vercel-labs/agent-browser#snapshot-options)、[命令解析器](https://github.com/vercel-labs/agent-browser/blob/main/cli/src/commands.rs)、[Diffing](https://agent-browser.dev/diffing)。

Browser Use serializer 源码做可见性、交互信息和简化树处理，并对 iframe/Shadow DOM 内容作专门处理；这说明页面表示本身是重要工作，而非只把完整 HTML 截短。[Browser Use serializer](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/serializer.py)。

**建议**：先给现有 `browser_snapshot` 加只读的 scope/内容模式，输出可读正文和相关可操作 refs，按节点或行保留结构并明确截断。搜索结果、帖子、文档页面应能直接给标题、链接和正文摘要。保留完整快照入口，不能仅用 interactive-only，否则读文章会丢正文。

审批事实应继续由 host/worker 采集，不能因为模型只见到部分页面就减少安全检查。优化最多 200 个 refs 的采集前，先测其耗时；未获得事实仍须保守处理。delta 应晚于 scope，且必须有完整恢复、baseline ID 和页面切换失效机制。

**验收**：对长 Google 搜索结果、文档页、动态列表记录返回字符量、工具回合、提取完整性和总耗时；不预先承诺固定节省比例。

### 3. 保留 Playwright auto-wait，替换固定 400ms 猜测

当前 `getByRef(...).click()/fill()` 已利用 Playwright 动作等待；问题在于 `settle()` 对动作后统一等待 `domcontentloaded` 再固定 400ms。SPA 的内容更新不必触发新的 DOMContentLoaded，而固定延时可能既浪费时间又仍不够。[当前 settle](../src/pi/browser/browserWorker.ts)。

Playwright 的 click 本身检查可见、稳定、可接收事件、enabled 等条件；官方不建议把固定 timeout 当作生产同步方式。agent-browser 的官方 skill 也建议根据元素、文本或 URL 等目标状态等待，并解释 SSE/WebSocket/轮询会让通用 `networkidle` 不可靠。[Actionability](https://playwright.dev/docs/actionability)、[waitForTimeout](https://playwright.dev/docs/api/class-page#page-wait-for-timeout)、[agent-browser waiting](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/SKILL.md#waiting-read-this)。

**建议**：使用有界的导航、相关内容变化或预期元素信号；没有已知目标时返回当前状态和仍在加载的信息，允许再读。不要全局改成 networkidle。超时后先观察，不自动重放可能已经提交成功的 click/press。

**验收**：慢导航、延迟 SPA 更新、持续 SSE 三个 fixture 都能得到新状态，或明确返回有界等待超时；不得重复提交。

### 4. refs 绑定页面和任务，避免串会话

当前 service 的 queue 只保证一个动作执行完再执行下一个，多个对话仍共享同一页、`elements` 和 `snapshotText`。因此另一 Agent 导航后，先前对话持有的 refs 和审批依据可能已经过时。[当前队列与快照](../src/pi/browser/browserService.ts)。

agent-browser 当前 docs 的准确描述是：仍存活的 DOM 元素可跨快照保留 refs；元素替换、page/iframe 导航会失效，不复用旧 ID；虚拟 accessibility 节点是 snapshot-local。不能照搬旧示例中“每次 snapshot 所有 refs 都变”的简化说法。[Ref lifecycle](https://agent-browser.dev/snapshots#ref-lifecycle)。其会话文档另有 CDP 场景下 pin tab 的设计，可用作并发隔离参考。[Sessions](https://agent-browser.dev/sessions)。

**建议**：当前单浏览器先增加轻量任务租约，动作携带 conversation/page/snapshot generation；用户接管、导航、切页、其他任务拿到控制权时明确失效。旧动作返回“重新 snapshot”，不要偷偷寻找相似按钮再执行。审批前后都要校验作用页面和 generation，实际动作仍重读关键事实。

**验收**：两个对话交错操作、用户接管后交还、审批等待中页面改变，旧 refs/旧批准不能作用到新页面。先实现可靠失效，不急于做多 Agent 同时共享多个 tab。

### 5. 观察传输瓶颈，再调整接管通道

当前已用 CDP screencast、160ms 帧间隔、SSE 图像和合并输入 POST；此前鼠标缩放/输入串行问题已有修复。不能仅凭“用了 SSE”就判断应换 WebRTC。[worker](../src/pi/browser/browserWorker.ts)、[输入队列](../src/runtime/browserView.ts)。

agent-browser 流文档提供三个可借鉴点：保留最新帧防积压；帧 seq/捕获时间用于判断画面年龄；可选 renderer ack 限制一帧在途，并将输入处理与图像发送分开。文档也明确 ack pacing 受一帧传输加一轮 RTT 限制，存在吞吐取舍。[Streaming](https://agent-browser.dev/streaming)。

**建议**：先记录按键/点击发出到服务端处理、下一帧展示的延迟，画面年龄、丢帧、字节量和 worker CPU。优先减少过期帧积压、处理尺寸和重连；只有 POST RTT 或 SSE 背压成为主要瓶颈，才在原 Output BrowserView 中评估一个双向 WebSocket。仍只在可见时连接，并保持用户/Agent 互斥控制。

**验收**：正常链路和人为慢链路分别测 p50/p95 输入到画面延迟；断连、重新接管、连续鼠标移动时不重复输入、不落下 mouseup。

## 账户与持久状态的边界

持久 profile 继续是适合现有单用户产品的做法。MCP 文档明确同一个持久 profile 不能由多个浏览器实例同时占用；Browser Use 参数区分 user-data-dir 与 storage-state，不能把“保存 cookie”当成保存所有浏览器状态。[MCP profile](https://github.com/microsoft/playwright-mcp#user-profile)、[Browser Use browser parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters)。

本项目 `browser_accounts` 只提示曾保存会话的候选站点，使用前仍观察是否已登出。profile 存在、cookie 未过期、网站当前认可账户，是不同条件；不建议为了自动探测而定期访问邮箱、私信等私人页面。网站 UI 是不可信输入，账户目录也不扩张审批范围。cookie、storageState、CDP token 均不需要发给模型。

## Stagehand / Steel 的补充边界

Stagehand `observe` 返回结构化 Action，可先审查再交给 `act`；按 locator 缩小提取范围值得参考。但 v4 迁移文档明确缺少 Playwright 的 auto-wait、事件和 route 等兼容面；不要为此换掉当前已用于审批、代理和下载的 worker。其文档自述的速度提升、self-healing 不能视为本项目实测收益。[Observe](https://docs.stagehand.dev/v4/basics/observe)、[v4 migration](https://docs.stagehand.dev/v4/migrations/playwright)。

[Steel Browser](https://github.com/steel-dev/steel-browser) 更偏浏览器基础设施，官方仓库提供 session 生命周期、CDP/Playwright 接入和调试 UI。它可以作为未来独立浏览器池的参考，但此时引入会重复现有 sandbox/worker 职责。本次部分 Steel 官方详细文档打开失败，因此没有核实其 live viewer 的输入协议、延迟或自托管/云端功能完全一致；不据此推荐替换。[Steel README](https://github.com/steel-dev/steel-browser/blob/main/README.md)。

Browser Use 主仓库现在还链接 JS harness 与 Pi Agent；不能简单说它“只有 Python”。本次查看到 JS harness 主张将完整 CDP 暴露为模型可写 JS，这与 RaytoneBot 当前受限工具、服务端审批边界不匹配，因此没有纳入建议安装清单。[官方 JS harness](https://github.com/browser-use/browser-harness-js)。

## 许可核查

已打开 LICENSE：Browser Use **MIT**、agent-browser **Apache-2.0**、Playwright MCP **Apache-2.0**、Stagehand **MIT**、Steel Browser **Apache-2.0**。这里只确认所看仓库 LICENSE；若复制实现或引入包，应在固定版本时再次核查具体文件、NOTICE、依赖与商业云服务条款。

来源：[Browser Use LICENSE](https://github.com/browser-use/browser-use/blob/main/LICENSE)、[agent-browser LICENSE](https://github.com/vercel-labs/agent-browser/blob/main/LICENSE)、[Playwright MCP LICENSE](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE)、[Stagehand LICENSE](https://github.com/browserbase/stagehand/blob/main/LICENSE)、[Steel LICENSE](https://github.com/steel-dev/steel-browser/blob/main/LICENSE)。

## 推荐实施顺序与待验证项

1. **popup 生命周期 + 任务租约/refs generation**：先让登录窗口看得见、控制得对，旧动作不能跨页面执行。
2. **scope/正文读取 + 有界状态等待**：减少完整页面反复回传，改善动态页面读取成功率；保留现有动作 auto-wait 和安全事实采集。
3. **接管性能指标**：先测输入到展示延迟和帧新鲜度，再决定是否换 WebSocket。

后续对比应使用同一测试 sandbox、固定模型、相同 profile 和权限模式；公开搜索/文档读取与合成 popup/SPA/并发任务分别跑重复样本，记录每任务模型输入量、工具轮数、动作及接管延迟 p50/p95、popup 成功率、旧 refs 拒绝率与多 Agent 串页率。为防对外提交，动态/并发边界用合成站点。未跑这些基准前，不声称任何方案快几倍。

尚未验证：四个候选框架在 AgentSphere 2C/4G 上的内存与 CPU；与现有代理/UID 隔离的组合；相同模型任务的成功率、成本和耗时；Google/X/Apple 当前真实账号登录通过率；多层跨域 iframe 完整性。官方基准、star 数和“stealth”宣传均不替代这些实测。本报告链接跟踪调研时主线，正式采用前应固定 release/commit，尤其不要混用 Stagehand v3/v4 示例。


## 同日落地记录

已在现有 Playwright/CDP worker 内实现前两阶段：活动 page ID 与 popup/关闭回原页、现有 BrowserView 标签切换；conversation/snapshot 归属、每次快照独立的模型 refs、动作前事实复核；scope/full/interactive/content 快照与按行分页；有界文字等待，移除动作后的固定延时。Enter 等按键必须传快照 ID，避免旧批准落到新页面。手动输入批次绑定 page/control epoch，交还和切页先排空已经发出的输入；旧队列不重放。

第三阶段先补测量基础：帧带 page ID、递增 seq、捕获/接收时间；前端丢弃错页和旧序号帧；主机只记录输入批次大小与处理时长。保留当前 SSE/POST；尚未完成慢链路 p50/p95、字节量/CPU 横向基准，不宣称性能提升比例，不引入 WebRTC、delta 或额外 Agent 框架。

真实测试实例验证三个引擎调用新工具、可见文字等待、公开无账号 popup 自动切换、用户切回原页、鼠标点击与远端输入。完整结果与限制见 [验收记录](product/08-acceptance.md)。
