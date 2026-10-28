# MyGO 前端适配可行性评估

核查日期：2026-10-27。本文是调研快照，不代表已经采纳技术路线或完成移植。

## 对 RaytoneBot 的结论

**技术上可行；若目标是优化现有网页的流畅度、布局和交互，不建议引入 MyGO。若目标是独立桌面客户端，可将它作为保留 React 的轻量外壳候选。Go 自绘 UI 则属于前端重写，应单独立项评估。**

这里按“改善当前 RaytoneBot 前端”理解问题，未假定用户已经决定改做桌面产品。本地依据为 `b99e9ee` 上的当前工作树，包含任务开始前已有修改；本次只添加调研和索引记录，没有改动运行时代码。

| 方案 | 对当前项目的价值 | 相对改造量与判断 |
| --- | --- | --- |
| 继续优化 React/AgentUX | 网页、本机、云端入口共享收益；直接处理消息渲染、布局与交互 | 最小，当前优先 |
| MyGO WebView + 现有 React + Node | 独立窗口、托盘、快捷键、通知、打包分发 | 原型较小，完整分发中等；有桌面需求时可行，但没有已证明的聊天提速 |
| MyGO Go UI + Node 接口 | 可使用原生 Markdown 增量解析、虚拟列表和自绘渲染 | 高；重接输入、审批、工具状态、历史、产物等，当前不建议 |

表中改造量是基于依赖关系的判断，不是工期承诺。上游能力依据见后文。

### 当前代码说明了什么

1. **前端和 Agent 主机的边界已经存在。** [`piVitePlugin.ts`](../src/pi/piVitePlugin.ts) 把 Node 主机挂在 Vite dev/preview，浏览器用 [`piClient.ts`](../src/pi/piClient.ts) 的同源 HTTP 和流式响应通信。MyGO 的 Go service/IPC 不会自动替代 Pi、Claude、Codex、DSH、审批和持久化。桌面化也仍需准备 Node、引擎及浏览器自动化依赖。
2. **已经有基础性能优化。** [`piFrameCommit.ts`](../src/pi/piFrameCommit.ts) 合并同一动画帧的 React 提交；[`SessionSidebar.tsx`](../src/components/agent-preview/SessionSidebar.tsx) 的历史和搜索已窗口化；[`MarkdownText.tsx`](../src/components/agent-preview/MarkdownText.tsx) 有 memo；[`vite.config.ts`](../vite.config.ts)、[`sandboxLibs.ts`](../src/components/agent-preview/outputframe/sandboxLibs.ts) 和 Markdown 目录已有拆包与延迟加载。不能把这些当作尚未实现的建议。
3. **有三个值得测量的剩余开销点。** [`agent-shell.tsx`](../src/agent-shell.tsx) 的每次可见事件提交仍重新转换全量事件、调用 `replayAgentUXEvents` 和 `createAgentUXViewModel`；[`ChatFrame.tsx`](../src/components/agent-preview/ChatFrame.tsx) 构建完整聊天行；[`WritingText.tsx`](../src/components/agent-preview/WritingText.tsx) 每次文字显现都会把变化后的全文交给 Markdown 渲染。这些是源码识别的候选点，尚未用 profiler 证明是当前瓶颈。
4. **不能靠换一个 API 就宣称增量化。** 只读核查冻结 SDK 的 `runtime/dist/index.js` 后，发现其 `append()` 内部仍调用全量 replay，`render-core` 也遍历并排序事件。应先测量，在现有 owner/runtime 内寻找最小修复；如果需要改变冻结 SDK，按 [依赖退出规则](product/04-dependency-exit.md) 单独评估，不能直接改 vendor。

现行 [ADR-001/025](product/07-decisions.md) 保留自有 React 组件，并要求每种产品状态只由既有组件负责。Go 重写会改变该技术决定；本报告没有采纳这条路线，也不建议先并行造一套 Go 侧栏、聊天或输出面板。

### 如果要验证桌面化，最短路径

先做一个固定 MyGO 版本的 macOS 单窗口原型，直接打开现有 `http://127.0.0.1:5188/` 整站；云端模式加载已有 HTTPS 登录入口。首轮沿用现有 Node 主机和 HTTP 协议，不必先加入 Go IPC 或重写组件。这样能尽早回答“目标 WebView 是否完整承载当前产品”。

不要在首轮直接嵌入 `dist` 后跨源调用旧服务：MyGO 的生产页面 origin 与现有地址不同，而 [`requestOrigin.ts`](../src/pi/requestOrigin.ts) 拒绝不同 origin，当前 API 又使用根相对路径。后续若要内嵌静态资源，应明确路由/代理及来源校验，不能通过全面放开 CORS 来绕过。

验证应覆盖：中文组合输入/粘贴、流式回复/停止/重连、审批和安全输入、长对话滚动与历史定位、HTML/PDF/音视频产物、浏览器接管、下载/外链、主题及窗口缩放。PDF 当前依赖 [`navigator.pdfViewerEnabled`](../src/components/agent-preview/outputframe/openedItemBody.tsx) 和浏览器阅读器，是尤其需要在 WKWebView/WebView2/WebKitGTK 实测的差异点；HTML 继续保留现有 sandbox/CSP。

原型通过后，再评估随包 Node 与引擎、健康检查、端口、退出/后台任务策略、签名和更新。关闭窗口是否继续例行任务必须保持明确语义。只测试 macOS 不能代表三平台通过。

性能对照使用同一机器、同一构建和同一受控事件记录，分别量冷启动、完整进程树内存、流式长任务、滚动/输入延迟与 DOM 数量；把 Node/浏览器 worker 纳入资源统计。先测现有浏览器，再测 WebView。若没有独立桌面需求，应先在 React 路线上完成这组测量，再决定是否需要架构变化。

## 上游版本与证据范围

- 固定源码快照：[`ccb2aef8a6859270ba35dc7fa8822822b31a49b0`](https://github.com/egoist/mygo/tree/ccb2aef8a6859270ba35dc7fa8822822b31a49b0)，提交时间 2026-10-27 14:49:42 UTC。以下源码和文档链接固定到该 SHA，不混用后续 `main`。
- 核查时最新发布版为 [v0.7.1](https://github.com/egoist/mygo/releases/tag/v0.7.1)，发布于 2026-10-27；源码快照在这个版本之后。实际试验应固定版本，并核对使用的 API 是否已经进入该发布版。
- [GitHub 仓库元数据](https://api.github.com/repos/egoist/mygo)显示仓库创建于 2026-09-26，许可证为 MIT。截至本次核查，公开仓库历史约一个月；这不能证明作者此前没有内部开发，但说明可观察的公开使用历史较短。
- 已阅读官方文档，并抽查 `frontend.go`、`channel.go`、`cmd/mygo/resources.go`、`backend_js.go` 和 `ui/markdown/view.go`。未执行 MyGO 代码、未构建示例、未进行三平台功能或性能测量。

## 两种 UI 路径

| 路径 | 上游已提供的能力 | 对已有 Web 前端的含义 |
| --- | --- | --- |
| WebView 窗口 | 加载 HTML/CSS/JS，开发时使用现有 dev server，生产时嵌入前端构建目录；macOS 使用 WKWebView、Linux 使用 WebKitGTK、Windows 使用 WebView2 | 可复用 React/Vite，不要求把页面改写成 Go；收益主要是桌面集成和应用分发 |
| Go 原生 UI | 用 Go 的 `ui` 包描述状态和视图，自行在 GPU 上绘制：Metal、Direct3D 11、OpenGL | 原生控件不是可直接安装的 React 组件；迁移已有 React 界面需要重写其视图、事件和状态连接 |
| 原生 UI 内嵌 WebView | 原生 UI 可以包含网页，网页仍可使用生成的 TypeScript 客户端、事件和 channels | 技术上可渐进混用，但需要处理两个 UI 世界的状态、焦点、布局与权限边界 |

来源：[README](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/README.md)、[前端加载](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/frontend.md#how-pages-load)、[原生 UI](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/ui/README.md)、[内嵌 WebView](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/ui/web-view.md)。

### React/Vite 复用和通信

`devUrl`、`devCommand`、`buildCommand`、`frontendDist` 允许接入现有前端工具链。生产资源通常从 `mygo://localhost` 提供；Windows 的对应 origin 是 `http://mygo.localhost`。SPA 路由的无扩展名路径可以回退到 `index.html`。因此相对 API 地址、CORS、浏览器存储所属 origin 必须重新核对，不能仅以开发窗口能打开判定生产包能用。[配置](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/configuration.md#development-and-the-frontend)、[前端](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/frontend.md)、[实现](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/frontend.go)。

绑定 Go service 可生成 TypeScript 客户端；事件支持 Go → 页面推送；`Channel<T>` 提供有序流、关闭和取消。页面关闭、导航或主动关闭 channel 会取消调用 context；源码的 channel 背压窗口为 1 MiB。这能承载模型 token，但不是既有 Node HTTP/SSE 接口的自动替代品：换通信需要适配协议、错误、取消与恢复语义。[绑定与 channels](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/bindings.md#channels)、[channel.go](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/channel.go)。

### 原生聊天相关能力和边界

原生 UI 已有适合聊天的能力，不能以“缺 Markdown 或虚拟列表”否定它：

- `ui/markdown` 支持 CommonMark、GFM 表格/任务列表、代码高亮和流式回复；`Stream` 对新增文本增量解析，提供文字逐步显现、选中复制以及多种代码块定制入口。
- `ui.List` 支持虚拟化和跟随底部；官方 `markdown-chat` 示例展示模拟流式回复。示例不是已经接好 Agent 工具、审批和历史恢复的工作助手。
- 原生文本输入提供 IME；但现有聊天输入、中文组合输入、快捷键和选择行为仍需实际验收。
- 数学公式默认显示 TeX 源码，公式渲染需提供 `Math`/`InlineMath` 回调；Mermaid 示例同样依赖应用自行生成图像。不能把 Markdown 语法支持等同于 KaTeX/Mermaid 成品渲染。
- raw HTML 默认显示为文本，部分行内格式标签可生效；HTML block 可用回调定制。这不等价于通用 HTML/CSS/JS 产物预览。
- 网页支持 `PrintToPDF`。已读源码与文档未证实存在等价于完整 PDF 阅读器的跨平台原生 UI 组件；PDF 预览宜保留现有网页实现并实测各 WebView。

来源：[Markdown 文档](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/ui/markdown.md)、[Markdown 实现](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/ui/markdown/view.go)、[UI 能力索引](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/ui/README.md)、[打印与 PDF](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/windows.md#printing-pdf-and-screenshots)。

### 原生 UI 也有浏览器目标

MyGO 已支持把 Go 原生 UI 编译为 WebAssembly，并在浏览器 Canvas/WebGL 2 上绘制；`mygo build -platform web` 产出静态站点。因此“使用原生 UI 就绝对不能保留网页”不成立。但这条路复用的是 Go UI，不是已有 React/DOM：

- 官方文档明确浏览器目标尚不能让辅助技术读取内容。
- WebView 窗口、应用菜单、托盘、全局快捷键、文件对话框等没有等价实现；绑定 IPC、事件和更新器等桌面 API 不提供原功能。
- 上游给出的计数器示例是 8.2 MB WASM、gzip 后 2.2 MB；这是上游示例数字，不是本项目打包结果。
- 所以保留浏览器访问在技术上有路径，但现有 React 应用转为 Go/WASM 仍是一轮前端重写，并需重新验证可访问性与网页能力。

来源：[浏览器目标](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/ui/browsers.md)、[`backend_js.go`](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/backend_js.go)。

## Node、打包和平台差异

MyGO 可携带辅助可执行程序，官方明确允许另一种语言写的 server：资源按 OS/架构放进 `resources`，应用以 `exec.Command` 启动。构建器复制并处理这些 helper 的签名。因此保留 Node host 并配 Go 桌面壳可行；但 Node/runtime、依赖和引擎的准备、启动、健康检查、退出、崩溃恢复与数据目录仍由应用负责，不能推导出“现有 Node 项目自动变成几 MB 单 Go 二进制”。[helper executables](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/distribution.md#helper-executables)、[资源实现](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/cmd/mygo/resources.go)。

| 项目 | 已核实事实 |
| --- | --- |
| 工具链 | 固定快照 `go.mod` 要求 Go 1.27.3；配置文件可使用 Bun，或 Node.js 22.6+ 读取 TypeScript 配置；前端工具链另计 |
| macOS | 系统 WebView；默认最低系统版本配置为 12.0；正式签名、公证和 dmg 生成需 macOS 工具 |
| Windows | WebView2，Windows 10 可能需要单独安装 runtime，Windows 11 包含；安装器使用 NSIS |
| Linux | Web 前端需要 GTK 3 和 WebKitGTK 4.1；原生 UI 仍需要 GTK 3；托盘/全局快捷键等受桌面环境影响 |
| 跨平台编译 | MyGO 本身不要求 cgo，可交叉编译；平台签名/安装器工具和应用依赖仍可能要求对应平台 |
| 媒体 | WebKitGTK 不从自定义 scheme 播放 audio/video，官方建议使用 loopback HTTP 提供媒体 |
| 更新 | 提供签名完整包与 delta updates；更新密钥、更新源、发布、安装位置写权限等仍需配置 |

来源：[`go.mod`](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/go.mod)、[安装前提](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/getting-started.md#install)、[配置](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/configuration.md)、[分发](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/distribution.md)、[前端协议](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/frontend.md#custom-protocols)、[更新](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/updates.md)。

## 与产物预览直接相关的权限边界

默认情况下，应用自己的页面和自定义协议页面可以调用绑定的 Go 方法。因此用户文件、Agent 生成 HTML、第三方网页不能直接作为可信的顶层应用页面加载；官方提供 `PageOptions.Untrusted` 并说明如何限制导航、权限、下载与事件。iframe 不能直接调用 Go 绑定，但不能因此省略现有产物隔离。此项是迁移产物面板的具体兼容约束。[信任边界](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/frontend.md#trust)、[谁可以调用 Go](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/bindings.md#who-may-call)。

## 性能与成熟度结论的限度

官方性能页报告的是 `ui.Tester` 上的 CPU 稳态帧测试，明确不包含原生窗口进程内存或 GPU 资源，也没有与其他 GUI 框架比较。50 KB Markdown 回复的 1.3 ms 稳态帧、0.8 ms 流式帧等是上游在 Apple M5 上报告的结果，本次未复测。它们属于 Go 原生 UI 路径，不能当成现有 React 页面套入 WebView 后的性能收益。[性能方法与限制](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/docs/ui/performance.md)。

MyGO 已有发布版本、三平台 CI 和大量能力文档，并非只有概念演示；同时公开历史短、版本仍为 0.x，近期 [v0.7.0](https://github.com/egoist/mygo/releases/tag/v0.7.0) 明列行为破坏变更，后续 [v0.7.1](https://github.com/egoist/mygo/releases/tag/v0.7.1) 修复 macOS 窗口拖动问题。合理定位是“值得固定版本做小规模验证的新框架”，现有证据不足以承诺降低维护成本或满足生产稳定性要求。[CI 配置](https://github.com/egoist/mygo/blob/ccb2aef8a6859270ba35dc7fa8822822b31a49b0/.github/workflows/ci.yml)。

## 本次验证边界

完成官方文档/源码与本地调用链核对、文档相对路径检查和 diff 空白检查。未安装 MyGO、未构建桌面原型、未改业务代码、未运行模型或性能基准；不报告帧率、内存或启动速度的实际提升。以上最小原型和性能对照均为后续建议，尚未执行。
