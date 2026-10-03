# RaytoneBot 可行性与本机验证

调研日期：2026-10-02。目标：取材 AgentCanvas 的 UI/UX，先在本机验证，再评估部署到已有 Cloud Sandbox。下文工期和技术选择是判断，代码事实附一手来源。

研究分类索引（2026-10-03 更新）：

| 分类 | 项目/笔记 | 当前决定 |
| --- | --- | --- |
| UI/UX 与本机基线 | AgentCanvas + Pi（本文） | 继续使用，已完成本机原型与有限验证。 |
| 场景与交互参考 | CopilotKit OpenXX（本文） | 按需求借鉴交互；不整体引入 Intelligence 栈。 |
| 持久助手产品机制 | [nightly-labs/openbot](nightly-openbot-assessment.md) | 借鉴工作区、队列与云唤醒；当前非商业许可不适合作为商用代码底座。它不是 CopilotKit/OpenBot。 |
| 持久执行后端与云环境候选 | [MiniMax-AI/OpenAgentCore](openagentcore-assessment.md) | MIT，优先验证后端能力；当前不替换 Pi。重点核对审批、事件恢复、本机 Core 与已有云接入。 |
| 云端部署实测 | [AgentSphere](agentsphere-deployment.md) | 现有 AgentCanvas + Pi 已部署；HTTP 与鉴权检查通过，浏览器视觉及真实模型任务未完成。 |

分类区分“现已采用”“行为参考”“待验证的代码复用候选”，不将源码支持等同于实际跑通。

## 结论

可以快速做出可交互原型。最短路径是 **AgentCanvas 原生导出 + 已有 Pi runtime**，按需求借鉴 OpenXX 的交互和业务能力。整套 OpenDots/OpenBot 换皮会额外带入 Intelligence、另一套会话状态和执行设施，当前没有必要。

AgentCanvas 导出的是独立 React/Vite 工程。已内置 Pi、同源 HTTP/NDJSON、工具执行、审批、停止、会话隔离和模型配置；不是从空白聊天框开始。但会话目前仅在内存中，静态部署 `dist/` 不包含 Pi 服务。[导出与接入说明](https://github.com/raytone-lab/agentcanvas/blob/main/docs/CONNECTING_AI.md)、[Pi 边界](https://github.com/raytone-lab/agentcanvas/blob/main/docs/PI_RUNTIME.md)。

需要取用的是导出后的 Agent 产品界面；配置器的预设栏不应进入 Bot。公开的 `@agentmatrix/agentcanvas-react` 包主要提供配置/预览边界，不带网络与运行时，不能直接把它当成完整在线 Bot SDK。[包契约](https://github.com/raytone-lab/agentcanvas/blob/main/docs/EMBEDDABLE_PACKAGES.md)。

## OpenXX 值得借什么

| 项目 | 借鉴点 | 对本次的意义 |
| --- | --- | --- |
| [OpenDots](https://github.com/CopilotKit/OpenDots) | 专家角色、Spaces 文档、会话转文档、定时工作、聊天内审批 | 可作为后续产品能力参考。原样聊天需要 Intelligence；SQLite 存页面与元数据，完整会话在 Intelligence。 |
| [OpenBot](https://github.com/CopilotKit/OpenBot) | 通用助手、电脑视图、文件/终端、活动记录、人工接管 | 最贴近未来沙箱 Bot，但其完整栈包含 Hono、PostgreSQL、Intelligence 和电脑服务。 |
| [OpenMuse](https://github.com/CopilotKit/openmuse) | 任务进度、计划、文件/浏览器结果，移动端与 Web | 借交互；本机首版无需迁入 Expo 与多 worker 部署。 |
| [Open Multi-Agent Canvas](https://github.com/CopilotKit/open-multi-agent-canvas) | 聊天与任务工作区并排，多 Agent 状态 | 借布局。旧仓库已提示迁入 CopilotKit monorepo，不应直接照抄旧依赖。 |
| [Open MCP Client](https://github.com/CopilotKit/open-mcp-client) | 工具配置、调用卡片和表格结果 | 将来接工具时可参考，当前不是必需后端。 |
| [OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) | 工具卡片、共享状态、交互式结果 | 固定组件先行；动态 HTML/SVG 产物可后加。 |

这些是独立示例/模板，并非统一可拼装的 OpenXX 应用框架。CopilotKit 的 AG-UI 与 AgentCanvas 的 AgentUX 也不是同一事件协议；如果采用其运行时，需要映射事件以及实现提交、取消、审批回传，不能只换渲染组件。[OpenDots AG-UI 链路](https://github.com/CopilotKit/OpenDots/blob/main/src/client/Chat.tsx)、[AgentCanvas 事件接缝](https://github.com/raytone-lab/agentcanvas/blob/main/docs/CONNECTING_AI.md)。

OpenDots、OpenBot、OpenMuse 等模板使用 MIT，不代表 Intelligence 也按 MIT 提供。官方 Intelligence 自托管文档列出 Team self-hosted / Enterprise 和有效 license；基础 CopilotKit OSS 与这些模板主动依赖的平台服务应区分。[自托管说明](https://docs.copilotkit.ai/intelligence/self-hosting)、[OSS 与平台边界](https://docs.copilotkit.ai/ag2/concepts/oss-vs-enterprise)。

## 本机实验结果

已在此目录生成可独立安装的 RaytoneBot，地址 `http://127.0.0.1:5188/`。沿用 AgentCanvas 组件、事件适配、Pi SDK 和默认模型；修改品牌与中文欢迎语、开放模型设置，隐藏 Git/debug 面板。保留许可证。

- `npm run build`：通过，含 TypeScript 检查。构建保留上游的大 chunk 提示，未做无关性能重构。
- `npm run check:local`：通过。实际启动本地 Pi SDK，确认 7 个工具、首页、空 prompt 校验与跨站请求拒绝；不发送模型请求。
- 上游 `piHost.test.ts` 与 `vendorParity.test.tsx`：25 项通过，覆盖运行时与事件渲染。这些测试不等于真实模型任务验收。
- 浏览器：欢迎页、模型设置、工具审批演示和普通代码产物预览显示正常，控制台未见错误。演示事件不执行其中命令。
- 发现上游限制：`Artifact action` 演示中的结构化表单打开后显示 `[object Object]`，需要补对应的产物渲染映射；不能据普通代码预览成功就宣称所有富产物已经可用。本次保留原实现并记录。
- 2026-10-02 尚未进行 Cloud Sandbox 部署；2026-10-03 已补充 [AgentSphere 部署实测](agentsphere-deployment.md)。真实模型任务、长期会话存储与后台任务仍未验收。

本机工作目录不构成权限隔离；Pi 工具运行在当前用户权限下。默认修改需审批，服务只监听 loopback。会话为临时内存数据，刷新后不恢复。

源码快照：AgentCanvas `2019158e472a360cd02897534221a8474b18ccd6`；OpenDots `b01ac1f6a903e5e56c119d960901353ac0a3d171`。

## Cloud Sandbox 路径

2026-10-03 已获得 AgentSphere 使用指南及部署凭证，使用 E2B Python SDK 1.11.1 将现有 Pi 应用部署到 `agentmatrix-v1`；公网页面、静态资源、Pi SDK 与密码保护已验证。浏览器自动化被客户端拦截，真实模型任务与持久化仍待验证，详见[部署记录](agentsphere-deployment.md)。以下保留通用接入判断。

以下两条是现有 Pi 路线。新增后端候选 OpenAgentCore 已单列[研究笔记](openagentcore-assessment.md)：如选择该后端，现有云可先评估应用管理的 `self_hosted` daemon 接入，实例生命周期由应用负责，无需一开始开发 Sandbox Provider。这是候选路径，尚未实施；它的原生工具审批与当前 Pi 不等价。

1. **可运行常驻 Node 并暴露 HTTP 的沙箱**：优先把 Pi 与工作目录放入沙箱，保留现有 UI 和事件协议；增加带鉴权的 Node 服务入口，保持流式输出，配置卷与会话恢复。静态托管不能替代执行进程。
2. **仅提供命令/文件执行 API 的沙箱**：保留应用和 Agent 进程在服务端，按实际 API 替换工具执行位置；若要浏览器截图/接管，另核实平台能力。

现有 Pi 请求校验只接受 loopback 浏览器来源，所以不能直接把 `vite --host 0.0.0.0` 当云端部署。需要明确可信入口、用户鉴权和沙箱归属，保留审批边界。[来源校验](https://github.com/raytone-lab/agentcanvas/blob/main/src/pi/requestOrigin.ts)。

OpenBot 已有 `docker/shared/sandbox` 适配边界，但其中 `sandbox` 指 Kubernetes agent-sandbox CRD；`shared` 仍要求兼容其 computer HTTP API，不能填任意云平台 key 就接通。[provider](https://github.com/CopilotKit/OpenBot/blob/main/server/src/computer/provider.ts)、[sandbox 实现](https://github.com/CopilotKit/OpenBot/blob/main/server/src/computer/sandbox.ts)、[computer client](https://github.com/CopilotKit/OpenBot/blob/main/server/src/computer/client.ts)。

## 最小后续范围与工期判断

在模型可用、单用户、无额外外部应用集成的前提下：本地可看可点原型本次已完成；补真实模型任务验收、会话持久化、产物保存与失败恢复，估计 3–5 个工作日。云端接入在确认平台支持 Node/流式端口/持久目录后再定，常规情况下可按额外 2–5 个工作日预估；这不包含完整浏览器接管或多用户隔离产品化。

首版闭环：发任务 → 查看执行状态 → 审批操作 → 查看/保存产物 → 恢复会话。语音、Slack、多 Agent 自动协作与复杂定时调度等到具体需求出现再增加。
