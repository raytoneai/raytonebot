# OpenAgentCore：后端与云沙箱接入研究

研究日期：2026-10-02。目标：判断它是否适合承接 AgentCanvas UI 的 Bot，先本机实验，再接已有 Cloud Sandbox。

2026-10-03 补充：平台已明确为 AgentSphere，现有 Pi 应用已完成[云端 HTTP 部署验证](agentsphere-deployment.md)。其指南要求 E2B SDK 1.x，而本研究快照的 Core E2B helper 使用 2.51.0；不能直接认定兼容。未来若试 Core，优先核对应用管理的 `self_hosted` 路径。本次未部署 Core。

核对 main 快照 `f10deeb2b61d276a2768971db9f6ad813645fee6`。当日发布页最新版本为 [v0.0.5](https://github.com/MiniMax-AI/OpenAgentCore/releases/tag/v0.0.5)，发布 commit 为 `905375c63533708e21f13ddeabcbe9f114e504ee`；下文能力以研究快照为准，不能假定全部已进入该发行版。本次阅读官方文档、契约和相关实现，未安装 Core、运行其测试、调用模型或创建云资源。表中的“官方已验证”仅指上游的验收记录。

## 结论与分类

**值得优先验证为云端后端，但当前本机原型继续用 AgentCanvas + Pi。** OpenAgentCore 的价值是会话持久化、执行生命周期、原生 Agent 引擎与沙箱管理；其主 Web 是管理控制台，产品界面仍由 AgentCanvas 承担。仓库另有 Parsar 产品示例，可以参考接入代码。[架构][architecture]、[示例][examples]

| 分类 | 记录对象 | 对 RaytoneBot 的决定 |
| --- | --- | --- |
| 可复用候选，需接入验证 | MIT 的 Core、Session/Turn/Item API、文件/产物 API；已有 Harness 与环境实现 | 当需要持久会话、远端执行时优先做小实验。不能直接替换 Pi endpoint，也没有现成 Pi Harness。 |
| 值得借鉴 | Session 冻结配置、提交幂等、断线后读取历史、不确定执行不自动重放；Parsar 的服务端代理和流恢复 | 可在现有实现确有缺口时采用，不要求先迁入整套系统。 |
| 暂不引入 | 管理控制台作为产品 UI；全量 Parsar 应用；为未知云厂商预写 Provider；新增 Pi Harness；多引擎统一层 | 当前目标不需要；保留原生 AgentCanvas UI 与已有运行链路。 |
| 待验证 | 本机 Core 启动路径、真实模型任务、审批等价性、AgentUX 映射、云厂商能力、租期与文件恢复 | 未通过验收前，不将“文档支持”记录为“已经跑通”。 |

MIT 判断限于项目自有代码：允许商业复用并要求保留许可通知；Harness、SDK、镜像及云/模型服务仍适用各自条款。没有 nightly OpenBot 当前主仓库的非商业限制，但本次不是全部依赖的许可审计。[根许可证][license]、[发行物许可收集][thirdparty]

## 1. 定位：执行后端，不是 UI 组件库

官方结构是：

```text
RaytoneBot / AgentCanvas UI
  → 应用服务端：产品身份、Core 凭证、API 接入与事件转换
  → OpenAgentCore：API + PostgreSQL + 内置执行 Worker
  → Runtime daemon：本机或云环境，主动通过 WebSocket 回连 Core
  → Codex / Claude SDK / MiniMax Code：实际模型与工具循环
```

上图是拟议接法，尚未实现。Core 的 Worker 在同一个 Go 服务中，不必再设一个队列服务。官方部署另含 Web 管理台和网关；Core 使用自己的 PostgreSQL 库，不应让产品直接写其内部表。[架构][architecture]、[Core 服务][core]

Harness 是模型与工具循环的执行引擎。已列出的引擎是 `codex`、`claude_sdk`、`mcode`；模型接入受各自原生协议约束，并非所有模型都能在三者之间互换。当前 Pi 的 provider/model/thinking 配置不能原样透传。[能力矩阵][capabilities]、[模型执行][model]

## 2. API、持久化与恢复：最值得利用的部分

| 已确认机制 | 对产品接入的含义 |
| --- | --- |
| PostgreSQL 保存配置、会话、执行事实；有 Session 事务与执行 journal 实现 | 可以承接当前仅驻留内存的会话状态，但仍需 UI 恢复逻辑。 |
| Session 创建时冻结 Agent、模型与能力配置 | 改 Agent 影响后续 Session；现有会话不能按当前 Pi 的方式随意切换全部配置。 |
| 创建/输入支持 `Idempotency-Key`，同键不同内容冲突 | 丢响应后可以重试同一提交；这不等于外部工具副作用“恰好一次”。 |
| 输入被持久接纳后返回 202 | 202 不能显示为任务已执行成功；继续读 Turn 结果。 |
| 公共 SSE 只发送实时事件，不补发重连期间遗漏的历史 | 先订阅再发输入；断线重连后读 Turns/Items，并对齐流与历史，避免重复文本和漏工具卡片。内部有事件存储，不代表公共 SSE 支持历史 replay。 |
| 待执行 function 可从 Session 的 `required_actions` 恢复 | 历史 function_call 不代表仍待处理。已执行的外部操作应回传保存的结果，不能重做副作用。 |
| 丢失执行后，已被领取的工作失败且不自动重放；排队工作可以保持等待 | “有持久化”不等于“崩溃后所有任务自动续跑”。UI 需要明确失败/中断状态。 |
| 运行中的新消息用于 steering 当前 Turn | 不应直接解释为另开一个并行任务；用户任务队列仍是产品语义。 |

依据：[应用 API][api]、[事件契约][events]、[工具与恢复][tools]、[事务实现][journal]、[恢复测试源码][recovery]。测试文件作为实现证据，本次未执行。

“兼容 OpenAI Agents API”应理解为针对固定契约的实现：仓库固定 `openai-python 3.13.0`，扩展经 `x_agents_core` 表达。**保存某个标准字段，不代表该配置能够执行；也不意味着兼容任意 SDK 版本或全部 OpenAI 产品能力。** [上游固定版本][upstream]、[Wire 语义][wire]

几个影响首版的限制：公开 `reasoning` 配置被拒绝；启用的标准 web_search/programmatic_tool_calling 被拒绝；MiniMax Code 不支持公开 function tools 和图像输入；结构化输出仅 Claude 路径有条件支持；网络 `disabled/restricted` 不被当前执行配置接纳。应按选定 Harness 的能力设计功能开关，不能仅凭统一 API 名称展示全部功能。[能力矩阵][capabilities]

官方“Verified”覆盖 Docker 托管和 Linux self-hosted 等指定测试位置；E2B、microsandbox 的对应能力多属于“Admitted”。这不是我们在 Mac 或已有 Cloud Sandbox 上的验收结果。[能力矩阵说明][capabilities]

## 3. 审批、身份与隔离：不能直接继承当前体验

**当前 Pi 的“修改前审批”不能假定迁移后仍然成立。** 上游 Harness 接入文档明确采用无人值守工具执行：Codex 使用 `never` 审批和 full access；Claude 使用原生 default 模式，但 adapter 回调允许符合 profile 的工具，SDK sandbox 关闭；MiniMax 绕过权限询问并关闭其内置 sandbox。Claude 实现也能确认这一点。[Harness 执行策略][onboarding]、[Claude 工具回调][claude]

公开 function tools 的 required action 可以由应用决定是否执行，但它不是所有原生 shell/edit 调用的统一审批钩子。仅把事件渲染成 AgentCanvas 审批卡片，不能阻止已开始的操作。要保留原有审批承诺，必须验证实际执行前的阻断与回传，不能只做视觉映射。[工具契约][tools]

Runtime 以启动账户权限运行，不提供额外文件、权限或网络隔离；隔离来自外层容器/VM/沙箱。`workspace_directory` 是工作目录，不是访问边界。受限网络策略若有需要，应先核对外层环境能力。[概念与隔离][concepts]

Core 按 Project 隔离资源，同一 Project 的所有 key 共享权限与资源；没有现成的产品用户、成员、角色或只读 key。因此 Project key 应由应用服务端持有，多用户产品还需自己的身份与会话归属检查。Parsar 演示了 loopback 服务端代理，但不能因此认定已经提供公网多用户授权。[项目权限][concepts]、[Parsar][parsar]

## 4. 本机与 Cloud Sandbox：分开评估

| 位置/方式 | 官方边界 | 我们的判断 |
| --- | --- | --- |
| Core 一键安装 | Linux amd64，Python 3.9+、Docker/Compose；安装器拒绝非 Linux/x86_64 | 当前 Mac 不能直接照一键命令宣称支持。 |
| Core 源码开发 | Go 服务 + PostgreSQL + 迁移；提供 loopback 开发流程 | 可调查 Mac 源码或 Linux VM 路径，但本次未编译/启动。Compose 的 `linux/amd64` 模拟兼容性也未验证。 |
| macOS self-hosted Runtime | 明确支持 macOS arm64 执行 daemon，不要求 Docker/管理员 | 有可达 Core 后可将 Mac 作为执行端；这不等于整套 Core 原生 Mac 一键部署。 |
| Docker Provider | 官方节点面向 Linux amd64/systemd、rootful Docker、cgroup v2 | 已有后端，可用于后续 Linux 实验；不能等同于支持 Mac Docker Desktop 节点。 |
| microsandbox Provider | Linux amd64 + KVM，支持 microVM 与 checkpoint/idle suspension | 不作为当前 Apple Silicon 本机快捷方案。 |
| E2B Provider | direct 模式，无需 node；需模板、凭证及云端可回连的 HTTPS Core | 若已有服务确为 E2B/严格兼容接口，可复用；自定义 URL 不代表接受任意厂商 API。 |

依据：[安装][install]、[安装选项][installoptions]、[Core 开发][core]、[self-hosted][selfhosted]、[节点要求][nodes]、[E2B helper][e2bhelper]。E2B helper 固定 SDK 2.51.0，对模板目录/构建响应形状有要求。

已有 Cloud Sandbox 建议依次判断：

1. **应用管理的 `self_hosted`，优先验证。** 我们用云厂商 SDK 创建实例，在实例内启动 Runtime/Harness，daemon 出站回连 Core；云 key、续租和销毁仍由应用负责。这是官方文档已有的所有权模式，不必先开发新 Provider。删除 Session 不等于销毁自管云实例。[自管环境][selfhosted]、[E2B 两种接法][e2bdeploy]
2. **Core 管理云生命周期，出现需要后再做。** 新 Provider 要实现 `Create/GetInfo/Renew/Kill/RunCommand`，补配置、注册、能力声明和真实云验收；安装器/Web 还存在 provider-specific 配置，不能估作“填一个 URL 和 key”。[Provider 接入][provider]

`openai_hosted` 在这里是 API 的环境类型名，指 Core 管理的环境，并不表示计算由 OpenAI 提供。[应用 API][api]

尚缺云厂商/API/key。最少需核实运行架构、常驻进程、出站 WSS、模板/依赖安装、文件保存、租期/唤醒和清理能力。若平台只给零散命令执行接口，不能先承诺 daemon 常驻模式可行；也不能因会话存入 PostgreSQL 就推断工作目录会在云实例销毁后保留。

## 5. 与 AgentCanvas 的具体接缝

保留界面和组件，但接入至少涉及两条链路：

- **读链路：** OpenAgentCore SSE/Turns/Items → AgentUX 标准事件 → 现有投影与组件；覆盖文本、工具、取消、错误、文件和产物。断线后恢复历史及去重是实际工作，现有 passthrough adapter 不适用。
- **写链路：** 创建/选择 Session、发输入、取消、function result、上传/下载；同时映射选定模型和可用配置。当前 `agent-shell.tsx` 的提交仍直接调用 `runPiTurn()`，因此只填写 `liveEventSource()` 不会完成迁移。

本地核对位置：[backendAdapter.ts](../src/adapters/backendAdapter.ts)、[event-source.ts](../src/event-source.ts)、[agent-shell.tsx](../src/agent-shell.tsx)、[piClient.ts](../src/pi/piClient.ts)。

**比复制其整个 UI 更有价值的是 Parsar 的小段接入实现：** 服务端保管 Project key、API allowlist、创建 Session 的幂等恢复、实时流与历史对齐。它已有示例路径，可以减少从零猜契约的工作；只借实际需要的部分。[示例代码导航][examples]、[流恢复实现][live]

Parsar 仍是单用户示例，没有任务层或共享工作区；产品配置使用本地 SQLite，Core 另有 PostgreSQL。我们不能因此再引入一整套并行的产品状态库。当前无需修改 React UI、加入 CopilotKit，也无需预先抽象所有 Runtime。

## 6. 下一次验证的最小闭环

此段是候选实验计划，未实施，也未改变当前技术选型。

1. 选定发行版/commit 和**一个** Harness，确认与当前要求的模型相容；确定可用 Core 运行位置，完成一条真实文本任务。
2. 只接一个 AgentCanvas 会话：创建 → 订阅 → 输入 → 工具/文件产物 → 停止。验收真实行为，不用演示事件替代。
3. 重载浏览器恢复同一 Session；切断 SSE 再恢复；重复同一幂等提交；分别检查 Core/daemon 重启后的已完成与不确定任务状态，不重复外部操作。
4. 验证审批能否在工具执行前阻断。若所选执行路径不能满足，记录差异，不能将原有“修改需审批”继续显示为有效保障。
5. 拿到云资料后，将执行端放入一个自管云实例；验收回连、租期、取消、产物取回与销毁，再决定是否值得实现 Provider。

完成前，当前本机 Pi 路线保持不变。原 [可行性笔记](feasibility.md) 的工期针对既有 Pi 路线；不能直接套用为 OpenAgentCore 迁移承诺。

[architecture]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/architecture.md
[examples]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/examples.md
[license]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/LICENSE
[thirdparty]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/services/core/tools/e2b-provider/licenses.py
[core]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/services/core/README.md
[capabilities]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/harness-capabilities.md
[model]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/model-execution.md
[api]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/api/public-agent-api.md
[events]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/sessions-events.md
[tools]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/execution-tools.md
[journal]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/services/core/internal/persistence/postgres/sessionpg/execution_journal.go
[recovery]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/services/core/internal/store/runtime_worker_recovery_test.go
[upstream]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/upstream.json
[wire]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/wire-semantics.md
[onboarding]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/contracts/agents-api/harness-onboarding.md#native-process-ownership
[claude]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/packages/claude-sdk-adapter/src/workspace.ts
[concepts]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/concepts.md
[parsar]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/example/parsar/README.md
[install]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/getting-started/install.md
[installoptions]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/getting-started/install-options.md
[selfhosted]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/getting-started/self-hosted.md
[nodes]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/getting-started/nodes.md
[e2bhelper]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/services/core/tools/e2b-provider/README.md
[e2bdeploy]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/services/core/deploy/e2b/README.md
[provider]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/docs/sandbox-provider.md
[live]: https://github.com/MiniMax-AI/OpenAgentCore/blob/f10deeb2b61d276a2768971db9f6ad813645fee6/example/parsar/src/lib/live-session.ts
