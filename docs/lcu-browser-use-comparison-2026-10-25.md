# LCU 与 RaytoneBot 内置浏览器能力调研

日期：2026-10-25。外部项目：[amontlabs/lcu](https://github.com/amontlabs/lcu)。

先完成文档及测试源码审查，随后按用户要求在独立 AgentSphere sandbox 实测：LCU 安装、桌面沙箱、MCP、网页输入/点击、跨域 iframe 与截图均通过；详细版本、脚本及限制见[验证记录](../output/lcu-sandbox-2026-10-25/README.md)。没有访问个人浏览器或真实账号，没有做性能或任务成功率对测。外部源码固定在 `c38f4b6286ba74ebf053c2b3d1970e387556a559`；当日审查的 release 为 [v0.13.0](https://github.com/amontlabs/lcu/releases/tag/v0.13.0)。

## 本项目判断

**LCU 已在同模板的云端 sandbox 跑通；按“完全可替代才替换”的条件，保留现有浏览器。** 随后原生增强验证修正了早期判断：Playwright 1.64 本来就支持跨域 iframe refs，本项目已补模型截图、frameRef 区域读取和帧权限/失效校验，见 [T6.3 验收](../output/browser-vision-frames-2026-10-25/README.md)。LCU 的 Vault、Output 接管、动作审批和下载归属仍无完整替代链路；这属于需实现和验收的适配，不代表 LCU 永远无法支持。这里的“内置 browser use”是本项目 Playwright/CDP worker，不是 `browser-use/browser-use` 上游框架。

本项目代码按当前工作区核对，包含尚未提交的 Vault 等变更；实现存在不代表已部署到所有环境。

| 维度 | RaytoneBot 当前实现 | 对比判断 |
| --- | --- | --- |
| 常规网页操作 | 12 个浏览器工具；ARIA refs、正文/交互/区域快照、按行分页、文字等待、tabs、popup | 已有完整基础链路，换工具不自动提高任务成功率 |
| 视觉信息 | Output 实时画面与模型 `browser_screenshot` 分开；四引擎图片传输已验，无像素坐标动作 | 普通读图不再依赖 LCU；实际理解能力仍取决于模型 |
| 复杂嵌入页面 | 原有跨域 refs，加上 frameRef 区域快照、嵌套选择、origin 审批与导航失效检查 | 两方案均通过合成 iframe 用例，不能据此宣称复杂生产页面成功率相同 |
| 登录与浏览器位置 | 独立持久 profile，用户接管登录，Vault 单次授权填充 | LCU Chrome 扩展接本机 Chrome profile，复用已登录会话更方便；这是基于架构的推断，不保证网站不要求重新验证 |
| 产品闭环 | 现有 Output 实时画面、接管互斥、动作审批、停止检查、下载归属及 Vault | 接 LCU 要重新适配这些约束；上游有 harness adapter 不等于现有 UI/host 自动兼容 |
| 云端 | headless shell 或完整 Chromium + 私有 Xvfb；AgentSphere 有测试实例证据 | LCU 还需要官方 app/runtime、X11、D-Bus、扩展；对云端不是更轻的替换 |

本地依据：[工具定义](../src/pi/browser/browserTools.ts#L51)、[快照与 iframe 边界](../src/pi/browser/browserWorker.ts#L416)、[浏览器服务](../src/pi/browser/browserService.ts)、[审批策略](../src/pi/browser/browserPolicy.ts)、[Vault 填充](../src/pi/browser/browserService.ts#L404)。

**不能直接在当前 MCP 设置里接上 LCU 就获得同等集成。** HostToolResult 现已支持内置截图的 images，但普通远程 MCP 的 `mcpResultText` 仍将 image/audio 转成提示文字；LCU 尚需该解析路径、原生 instructions、生命周期及审批适配。[结果类型与远程 MCP 解析](../src/pi/mcpServers.ts)、[HostTools](../src/pi/memories.ts)。

独立 sandbox 已验证原生 Codex CLI → LCU MCP → 模型请求的图片传输：截图 JPEG 的 SHA-256 前后一致。该检查用本地脚本端点驱动真实 CLI，证明原生通道可用；没有经过 RaytoneBot 的 `codex app-server`/HostTools 集成，也没有真实模型推理。[传输证据](../output/lcu-sandbox-2026-10-25/codex-image-report.json)

部署证据须分开看：AgentSphere 的独立测试实例已验三个引擎、popup、接管和持久 profile；Google 登录后搜索仅有当时的一次链路证据，其他网站/长期登录不可推断。AgentMatrix 文档仍记录 Chromium/系统依赖与 UID 隔离缺口，换 LCU 不会自动解决。[浏览器验收](product/08-acceptance.md#2026-10-17-浏览器-review-与工作流最佳实践)、[AgentMatrix 缺口](agentmatrix-deployment.md#浏览器能力缺口2026-10-19-实测)。

初步调研曾建议可选后端集成；用户随后要求仅在完全可替代时替换，因此本轮不新增第二套浏览器入口或未接通的后端开关。现有实现保留。后续若重新推进迁移，应先满足下表的功能对等条件，再使用相同模型、权限与任务比较成功率、人工接管次数、总耗时和 token。本次仅改文档及独立验证记录，没有修改产品运行时代码或部署生产服务。

### 完整替换检查（2026-10-25，按用户附加条件）

“完全可替代”按现有产品行为判断，不仅是打开网页、点击和截图。检查当前工作区的 BrowserService/worker、Vault、审批与引擎调用方后，结论为**尚不满足替换条件**。

| 必须保留的行为 | 当前实现与 LCU 接入差异 | 差异性质 / 替换前条件 |
| --- | --- | --- |
| 安全登录填充 | 主机捕获原 DOM 节点，经逐次授权私有 IPC 填入；导航、节点替换、接管会失效；填后隐藏模型输出并阻止敏感下载。LCU 上游 `browserAuth` 依赖独立 broker，未建立可独立运行的安全认证实现。普通 JS `fill()` 不等价于这条主机秘密通道。 | 上游依赖与宿主适配；必须建立不经过模型参数/历史的可信填充、节点绑定及敏感页面保护，并通过现有 Vault 回归。不能把密码直接拼进模型工具调用。 |
| Output 实时观看与接管 | 现有 SSE 帧和用户输入绑定 pageId/controlEpoch，切页/交还先排空输入，离开视图释放按键。LCU 截图返回及 `markHandoff()` 的保留标签语义不等于远程接管；目前没有对接本产品输入/帧协议。 | 宿主适配；须在原 Output 上完成观看、输入、互斥、切页和断开清理。上游桌面预览/IAB 限制不证明我们的 Output 永远不能适配。 |
| 原有动作审批 | 当前使用实际元素、表单提交方法、精确站点及会话/快照引用判定。LCU 原生入口为任意 JS，一次可编排多个动作；Linux 原生桌面没有逐应用授权，工具级/站点级批准不能自动复用本项目逐动作分类。 | 宿主权限适配；须证明读取、提交、秘密输入、过期引用和停止队列与现有规则等价，不能用“一次批准全部 js”替代。 |
| Pi / Claude / Codex / DSH 共用能力 | 内置截图已贯通四引擎；普通远程 MCP 与 LCU adapter 尚未接入。产品 Codex 使用隔离配置的 app-server，单独 `codex exec` 的原生 MCP 成功不等同产品集成。LCU DSH 原生插件依赖自己的问题服务；上游明确 ACP 无该答复界面。 | 仍需 LCU instructions、elicitation、真实 session/turn ID 和每条结束路径的集成测试，不能只运行用户级 `lcu setup`。 |
| 下载、持久登录与云隔离 | 当前异步下载绑定发起任务/GUID，停止后丢弃，手动下载不继承其他 Agent 的工作区；浏览器有独立 UID/代理和受限目录。LCU 的下载路径 API、独立 profile fixture 及 JS 沙箱通过，不证明这些产品边界已迁移。 | 待实现/验收；须验证异步下载归属、关闭后 profile 保留/清除、UID/网络边界及恢复。不能把 JS kernel 沙箱视作现有部署隔离的替代证据。 |

本地依据：[Vault 捕获/填充](../src/pi/browser/browserService.ts#L374)、[worker 节点与下载状态](../src/pi/browser/browserWorker.ts#L38)、[浏览器协议](../src/pi/browser/browserProtocol.ts)、[动作分类](../src/pi/browser/browserPolicy.ts)、[Codex 隔离运行](../src/pi/cliHarness.ts#L567)、[Codex 文本结果](../src/pi/codexAppServer.ts#L126)、[DSH 宿主工具](../src/pi/dshHarness.ts#L95)。

上游依据：[接口盘点与 broker/IAB 边界](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/verification/browser-runtime-integration-plan-2026-09-27.md#already-wired-gated-or-outside-local-scope)、[共享客户端契约](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#shared-client-contract)、[审批边界](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#approval-boundary)、[DSH 的 ACP 边界](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#deepseek-harness)。broker/IAB 盘点有其注明的旧版 runtime 边界；本轮没有把它当成对所有较新 runtime 的不可实现证明，当前新 runtime 也尚无此等价集成证据。

本轮复验现有浏览器 18 项测试，全部通过、无跳过，包括真实 Chromium 的 Vault 节点绑定/不提交/敏感输出保护、接管与引用互斥、停止队列、popup 和后台 iframe 的下载归属。此结果验证的是迁移时不能丢失的现有行为，不是 LCU 对这些项目已经通过。[执行记录](../output/lcu-replacement-audit-2026-10-25/README.md)

**实施决定：保留 BrowserService、browserWorker、现有引擎与部署入口；不切换默认，不移除 Playwright，也不引入只支持部分能力的 LCU 开关。** 若继续做完整适配，先在原 BrowserService 后端边界闭合上述契约，所有引擎沿同一产品通道，再决定是否删除旧 worker；直接开放原生 LCU JS 工具不属于行为等价的替换。

### Sandbox 已有 Codex 能否复用

可以复用 Agent 调用端。当前运行代码启动的是 `codex app-server --stdio`；部署文档列出模板自带 Codex CLI。这里的 `app-server` 是 CLI 协议入口，不表示已经安装桌面应用及 CUA runtime。[启动参数](../src/pi/cliHarness.ts#L219)、[部署引擎](product/06-deployment-runbook.md#L103)。

LCU 的 Codex adapter 可以连接这个类型的调用端，但仍需官方桌面应用提供的原始 runtime，以及兼容的 CLI hooks、Chrome extension/native host 与 Linux X11/D-Bus 环境。我们已有完整 Chromium + 私有 Xvfb 的部署分支，可复用其中部分基础设施；其显示与 UID/网络边界是否适合 LCU 需要单独验收。[现有 headed 安装](../scripts/agentsphere/deploy.py#L254)、[LCU Codex adapter](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#codex-cli)。

实测进一步确认：相同 `agentmatrix-v1` 模板自带 Codex CLI `0.154.0`，但没有桌面 app、Xvfb 或 Chromium；只装 LCU 会被安装器拒绝。解包官方 app、补齐桌面依赖并安装独立 Chromium/扩展后，原 CLI 的 MCP 与 hooks 注册成功，LCU doctor 和浏览器动作通过，无需升级 Codex。Ubuntu 22.04 上使用对应系统库可运行本次路径，但它仍不在上游推荐的 Ubuntu 24.04 范围内；没有关闭 JS 或 Chromium 沙箱。现有 Codex 可以复用作调用端，不能代替这些运行依赖。[实测详情](../output/lcu-sandbox-2026-10-25/README.md)

## 外部结论

LCU 的主要价值是把官方桌面应用的 computer-use runtime 接到其他 harness，覆盖浏览器和原生桌面应用。它没有自行实现浏览器引擎，官方应用仍须安装在运行机器上。它比一个只有网页文本及元素动作的工具接口覆盖更广，但现有证据不能推出“同样任务更准、更快、更省 token”。[实现边界](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#L1-L26)

对 RaytoneBot 的合理候选方向是可选浏览器/桌面后端。云端可运行已实测，但接入仍需承担官方桌面 runtime、X11、D-Bus、Chrome 扩展、审批及生命周期；这不是更换一个 npm browser driver。[安装前提](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/README.md#requirements)

## 上游浏览器能力证据

以下表格记录上游文档与测试源码；本项目随后完成的实际检查单列在[验证记录](../output/lcu-sandbox-2026-10-25/README.md)，包括一项跨域 iframe 用例。

| 能力 | 外部证据 | 可以得出的结论 |
| --- | --- | --- |
| 浏览器发现、创建 tab、导航、AX 状态、文本输入、点击 | `tests/browser_runtime.py` 的真实 runtime 流程；另有 Linux Pi/Codex 模型运行记录 | 原项目记录了可用实例，不只是 README 宣称 |
| 模型可见截图 | 测试直接调用 `tab.getScreenshot()`，断言 MCP result 中有非空 `image` content；结果转发矩阵检查图片字节 | 截图能进入工具结果，模型/host 仍须支持图像输入 |
| 登录态、站点拒绝、陈旧/关闭 tab、reset、超时 | 隔离 fixture 覆盖 cookie 登录、禁止 origin 未被访问、旧 tab 拒绝与重启恢复 | 有这些具体回归证据；不是任意生产网站兼容性保证 |
| DOM / Playwright locator | 2026-09-27 原 runtime 源码清单列 DOM snapshot、locator、只读 evaluation、fill/check/select/wait | 接口存在；本次没找到对复杂页面的系统成功率数据 |
| iframe | 同一清单列 `PlaywrightFrameLocator` | 有 frame-scoped locator 接口证据；本项目随后验证了一个跨域合成用例，复杂生产页面仍未验证 |
| 文件选择、下载、对话框 | 同一清单列 file chooser、download path、JS dialog 接口及路径/审批检查 | 可作为补足功能的候选，不等于所有 provider 均可执行 |
| 拖拽、坐标等动作 | 清单列 AX drag 等动作；另外明确统一 Tinysky 选择 `Tab.ax`，关闭 `Tab.cua` / `Tab.dom_cua` override | 不能直接把原 runtime 所有 coordinate / DOM surface 都当成 LCU 当前已实测功能 |
| 一次工具调用内编排多个步骤 | 共享 client 使用持久 JS runtime，`js` 接受程序 | 可保留变量并串联步骤；减少 tool round-trip 是可能收益，不是已验证性能收益 |

浏览器动作与截图的直接测试源码：[tests/browser_runtime.py#L100-L132](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/tests/browser_runtime.py#L100-L132)。

宽 API 清单及其明确限制：[browser-runtime-integration-plan#L23-L64](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/verification/browser-runtime-integration-plan-2026-09-27.md#L23-L64)。该清单自述是源码盘点，不是桌面实测；所指原始 OpenAI runtime 代码不在 LCU 仓库内。本项目实测使用从官方 app 提取的较新 runtime，不能据此认为清单中全部接口都已验证。

独立结果证据：[Chrome opt-in record](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/verification/chrome-opt-in-2026-09-24.md)、[harness result matrix](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/PARITY-STATUS.md#maintained-harnesses)。Mac Chrome 记录是 SDK client 驱动的隔离页面保存与截图，不应改写为所有 harness 的真实模型测试。

## 桌面与部署前提

LCU 复用原 runtime 的窗口读取、无障碍状态、截图、点击、输入等原生桌面能力。其价值超出 browser use，例如在浏览器以外的应用完成操作。[README features](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/README.md#features)

| 环境 | 当前要求与限制 |
| --- | --- |
| macOS | Apple Silicon，已安装的签名官方 ChatGPT app，首次使用批准 Accessibility 与屏幕录制；Intel Mac 不支持 |
| Linux | ARM64 或 x64、Ubuntu 24.04 兼容 glibc、活跃 X11 桌面及 D-Bus、已安装官方 app；原生 Wayland 和 musl 不支持 |
| Chrome | 需要显式启用 browser surface，用户安装/启用官方扩展，LCU native-host relay，网站仍按 origin 审批 |
| Windows | 当前是 deferred candidate，v0.13.0 没有 Windows release archive |

来源：[requirements](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/README.md#requirements)、[enable Chrome](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/README.md#enable-chrome)、[0.13.0 release](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/releases/0.13.0.md)。

云沙箱不是绝对不可用：项目有隔离 Linux Docker + X11 + Chrome 测试。但它不是无桌面的 headless 浏览器方案；云环境需要检查已有桌面、官方 runtime 获取和安装方式、扩展、会话/显示服务及权限边界。[隔离 Chrome 记录](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/verification/chrome-opt-in-2026-09-24.md#linux-evidence)

Linux 上其默认设计把 JS kernel 留在沙箱，将可信 Sky worker 放到沙箱外以接触 X11；若容器/宿主禁止 user namespace 导致 bubblewrap 探测失败，原 runtime 会直接运行两个进程。此时没有 kernel 沙箱，不能只凭“在 Docker 里”推断 LCU 自身隔离成立。[Linux sandbox state](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#linux-sandbox-state)

## Pi / Codex / Claude Code / DSH

| 引擎 | 当前接入形态与边界 |
| --- | --- |
| Pi | extension 使用共享 MCP client；有真实模型 Linux GTK/Chrome fixture 证据，原图片结果可转发；本项目嵌入 Pi 仍需接 host contract |
| Codex CLI | MCP relay + Stop/Interrupt/SubagentStop hooks，必须 CLI 支持 MCP tool hook；工具发现隐藏 host-only 工具但 host 仍调用清理 |
| Claude Code | MCP relay + hooks；原生 app 审批另有 `lcu-approve` mod；Chrome 明确仍实验性，部分失败/中断未保证 tab 清理 |
| DSH | 实验 Cordis 原生 plugin，不能只注册普通 MCP；集成 DSH question card、模型指令和 turn end；macOS 有 Flash/Pro 运行记录，Linux/Windows/图像输入仍未验证 |

来源：[Pi](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#pi-extension)、[Codex](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#codex-cli)、[Claude](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#claude-code-adapter)、[DSH](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#deepseek-harness)。

RaytoneBot 不能因上游已有这些 adapter 就视作自动兼容：其 host 要提供真实 session/turn ID、原始 instructions、图片/错误转发、approval UI，并在 Stop/Interrupt 和关闭时调用 `turnEnded`。缺乏 elicitation handler 时共享 client 取消审批。[shared client contract](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#shared-client-contract)

审批另有平台差异：Mac/Windows 原 runtime 有 app approval，Linux 没有 per-app approval；Linux 桌面控制依赖 harness 的工具调用权限。Chrome origin approval 是另一层。不能把 Mac 的 app 授权体验泛化到 Linux。[approval boundary](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/ADAPTERS.md#approval-boundary)

## Runtime 来源与维护耦合

LCU MIT 许可不覆盖官方 app/runtime；release 不含 OpenAI 应用 payload，运行时从已安装官方 app 读取。Linux/macOS 都复用安装树，升级 app 会改变实际 runtime。应分别管理 LCU、官方 app/runtime、Chrome extension 和 harness 的版本。[provenance](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/PROVENANCE.md)

`tested-versions.json` 记录确切 app/CUA 组合，未列出的组合只警告而不拒绝。因此安装成功或结构兼容检查通过，不等于当前组合完成了动作验证。该记录最新 Mac 组合为 ChatGPT `26.1013.40934` / CUA `0.0.30/20261014203459-0849368674e2`，Linux 列出的较新组合为 `26.928.31416` / CUA `0.0.27/20260927214556-b77d38801cca`。[tested versions](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/tested-versions.json)

维护成本不是纯假设：v0.13.0 记录新版 Windows Store app 的 host layout 曾使安装失败，需要 LCU 更新适配。这是内部 runtime/host 结构耦合的实际例子；它不能用来推断 Mac/Linux 一定同样失败。[release changes](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/releases/0.13.0.md#changes)

## 对“更好用”的证据边界

已查范围包括 README、适配器契约、PARITY-STATUS、provenance、latest release、browser runtime 测试和多份 verification record。它们主要证明特定版本下能完成 fixture、正确传结果和执行清理；本次没有发现 LCU 与 RaytoneBot 或 browser-use 框架在同模型、同网站、同任务上的可比 benchmark。

项目自身比较 trycua 时也明确：没有证据证明任务成功率、延迟或 token 成本优势。这份比较的对象不是 RaytoneBot，因此只用于说明该文档的证据边界，不能借用为双方性能结论。[comparison boundary](https://github.com/amontlabs/lcu/blob/c38f4b6286ba74ebf053c2b3d1970e387556a559/docs/verification/trycua-sky-comparison-2026-09-28.md#L124-L136)

后续应固定 runtime/harness/model，在隔离 profile 对测普通表单、多 tab、视觉控件、iframe、文件选择、中文输入及 Stop/接管清理，观察任务结果、人工干预、耗时和 token。本次合成任务证明 LCU 能在我们的云端模板运行且补足部分接口能力；全面替换结论仍需要产品集成和真实模型对测。
