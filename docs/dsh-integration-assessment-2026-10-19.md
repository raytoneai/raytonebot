# DSH（DeepSeek Harness）接入评估

调研日期：2026-10-19（Asia/Shanghai）。上游基线：官方仓库 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)，commit [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317)，版本 `0.2.1-rc.2`，提交日期 2026-10-17。本仓基线为 HEAD `8c2ce43` 加当前工作树，按最新 Bot 服务端配置实现评估。仅做官方文档和源码静态核查；没有安装依赖、启动 DSH、调用模型或部署。上游链接固定到此 commit。

**综合判断：作为第四种可选引擎，接入难度中等；达到现有三引擎的完整体验，难度中等偏高。** 现有 Node 主机、事件适配器、审批、模型租约和界面均可复用。建议先做一天左右的技术验证，再决定是否完成产品化；不需要重做 UI、引入独立 Web 服务或替换现有引擎。

| 交付层级 | 范围与明确边界 | 累计工作量估算 |
| --- | --- | --- |
| 技术验证 | 固定版本 ACP，经现有网关完成一轮工具任务，验证执行前拒绝、停止和原生续接；不是可发布功能 | 0.5–1.5 人日 |
| 可用首版 | 创建 Bot 时可选 DSH；统一审批、普通工具、基础宿主工具桥接、会话恢复、文件产物与部署。文字按模型 step 提交显示；关闭 PTC/子 agent 等尚未验证路径；不提供原生历史分支 | 3–5 人日 |
| 接近现有体验 | 增量正文/思考、工具进度、失败重试去重、宿主工具覆盖、网页/群聊/IM/例行任务贯通，以及 Linux 隔离、备份恢复和浏览器回归 | 7–12 人日 |

估算假设一名熟悉此仓库的开发者连续投入，含相关测试和调试；各行是累计范围，不相加。上游兼容性尚未实跑，置信度中等。若首期还要求原生历史分支、PTC 嵌套调用与子 agent 全部达到同等展示/审批/停止语义，应另留 3–5 人日探索缓冲；是否可直接复用上游内核须由验证决定，不能将该缓冲视作完成保证。

当前三个引擎已经可使用 DeepSeek 模型；新增 DSH 的价值在于其原生执行策略和插件能力，不能仅凭官方 harness 身份推断质量、速度或成本会提升。建议技术验证用相同模型和少量同题任务比较成功率、耗时、工具调用和用量，确认收益后再投入完整适配。[现有引擎与模型](product/10-agents-and-permissions.md)

**上游结论：有现成双向机器接口，接入可行；优先验证 `dsh --profile acp`，不宜用 `headless --json` 充当完整交互协议。** ACP 已有审批请求、停止、持久会话恢复、工具生命周期和 MCP。主要缺口是逐 token 流、执行中工具输出、宿主权限的一致强制执行，以及原生分支等扩展体验；不能把“已有 SDK”理解成与现有 CLI 引擎协议完全等价。[ACP 官方能力](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/README.md)

## 1. 接口选择：已证实的支持差异

| 能力 | `headless --json` | TypeScript SDK / `sdk` profile | `acp` profile |
| --- | --- | --- | --- |
| 机器传输 | 单任务 NDJSON 输出，结束即退出 | 双向 stdio JSON-RPC，有现成 `@deepseek-ai/dsh-sdk-client` | 双向标准 ACP v1 stdio JSON-RPC |
| 文本/思考 | assistant 提交后发出；不是逐 token | 转发持久 `session.event`；没有实时 assistant frame 通知 | 提交后发 `agent_message_chunk` / `agent_thought_chunk`；名称含 chunk 不等于逐 token |
| 工具事件 | `tool_call` / `tool_result` | 完整持久 session 事件 | 通用 `tool_call` → `tool_call_update`（completed/failed） |
| 审批回答 | 没有交互输入协议 | 明确未实现 server→client request | 现成 `session/request_permission`，一次允许/拒绝 |
| 停止 | 结束进程 | 无 mid-turn cancel，须关闭 runtime | `session/cancel` / `$/cancel_request`，可保留会话继续 |
| 恢复 | `--session-id`，严格 cwd/归属/preset 校验 | `resumeSession`，恢复日志并修复被打断尾轮 | `session/resume`，持久化后跨进程恢复 |
| 分支/历史 | 不接受 forked session 的 adoption | 协议没有 fork 方法 | 不支持 fork、`session/load`、历史 transcript replay |
| 多会话 | 每次一个任务 | 同一 runtime 可有多个 session | 同一连接多 session，独立关闭 |
| Host/MCP 工具 | profile 插件组合 | profile 插件组合 | `session/new`/resume 可挂 stdio 或 Streamable HTTP MCP |

依据：[headless 契约及限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/README.md)、[SDK client 契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/README.md)、[SDK 方法/通知的完整类型表](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/protocol/src/types.ts)、[ACP 契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/README.md)。

额外限制：headless 中除 final 外的字符串限制 8 KiB，事件行限制 32 KiB；失败不一定发 error（仍须检查 turn reason 和退出码）。SDK 的 `run()` 表示 receipt-to-idle 活动区间，不保证返回内容仅因该 prompt 产生。这些都会使简单的“读每一行并透传”产生语义错误。[headless](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/README.md)、[SDK](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/README.md)

## 2. 执行前审批与宿主权限

**已证实：原生 ACP 可在执行前阻塞等待宿主回答。** `approval/request` listener 先 drain 已发送的工具更新，然后用 toolCallId 发 `session/request_permission`；只把 `allow-once` 视为放行，其余明确拒绝或取消。DSH approval 本身 fail-closed：无回答方、异常回答或无效值均不执行。请求不重复携带工具参数，宿主必须从先前 `tool_call.rawInput` 按 callId 关联。[ACP 实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/index.ts#L155-L177)、[approval 语义](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/approval.md)

**但原生桥只转发 DSH 发起的审批，不自动等于 RaytoneBot 的统一 approvalGate。** DSH 的 filesystem/shell/permission preset 有自己的策略。要让宿主掌握每次适用工具的放行权，需要受控 profile 中的 `tools/pre-execute` 插件：它是异步 waterfall，可返回 `allow` / `deny` / `cancel` / `ask`。`ask` 在真正 dispatch 前等待 approval；`signal` 取消可中止等待，只有 `allowed-once` 继续执行。`ctx.tools.guard()` 则只支持**同步否决**，不能直接承载异步宿主审批。[pipeline 与 `serviceAsk`](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1490-L1557)、[guard 定义](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L1134-L1151)、[decision 类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/index.ts#L600-L612)

**实施推断：** 在受控 profile 将需宿主判定的工具返回 `ask`，宿主依据现有 request/auto/allow-all 模式及拒绝规则自动或人工回答 ACP；同时保留 DSH 自身的否决，不能把原生 denial 覆盖成 allow。须验证 listener 顺序、原生工具与 MCP 工具、取消中等待、工具内二次 escalation、PTC 内层调用和子 agent。尤其 ACP 现有投影仅处理 `tool/call`/`tool/result`，没有投影 `tool/ptc-dispatch-start`/`tool/ptc-dispatch`，直接开启 PTC 可能让内层审批找不到已呈现的 callId；首期可固定普通工具模式，完整适配再补内层映射。[ACP 事件分支](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/session.ts#L349-L395)、[PTC 事件定义](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/src/types.ts)

## 3. 流式展示与失败语义

**已证实：DSH 内核有实时数据，ACP 没有暴露它们。** `agent/assistant-stream` 提供 start / chunk / end；chunk 包含 `text-delta`、`reasoning-delta`、`tool-call-delta`、usage、finish。end 标明 committed（包含持久事件 seq）或 abandoned，并且 attemptId/revision/index 可用于关联。这不是缺模型流，而是运输层刻意只投影提交结果。[frame 类型和事件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/runtime-types.ts#L127-L162)、[stream chunk 类型](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/types.ts#L470-L488)、[ACP 投影](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/updates.ts)

**实施推断：** MVP 可接受“每个模型 step 完成后出现文字”，但应在产品上说明；要达到现有逐字流，需维护一个小的专用 transport/profile 插件，或对 ACP transport 做受控扩展，监听实时 frame 并转换成既有 PiWireEvent。不能直接重复写 stdout，因为原 ACP 连接私有且拥有协议输出；应由单一 transport 协调，或通过单独受控 IPC 发送补充事件。必须处理重试的 abandoned attempt、提交后的去重、reasoning 与正文顺序、参数增量，不能把所有 delta 永久追加为已提交消息。[ACP 连接及事件订阅](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/index.ts)、[attempt 累积与结算](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/assistant-stream.ts)

工具完成/失败可直接映射现成 ACP `tool_call_update`；执行中的 shell output 则不在 ACP 中。DSH 的 job registry 有独立 `events`、`readAt` 和带 byte offset 的 output ring，前台 bash 也可登记成 job；需要输出面板实时进度时，专用插件须从此处追加桥接，处理截断/gap，而非假定存在统一 `tool_progress` 帧。[工具完成投影](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/updates.ts#L46-L88)、[jobs 输出与事件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/jobs.md)、[bash 前台/后台行为](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/shell/tool-bash/README.md)

## 4. 会话、停止与宿主工具

ACP 的 `session/resume` 校验 canonical workspace，恢复 persisted session 后不重放旧更新；`session/cancel` 取消当前活动，等待该活动及输出 drain，仍允许后续 prompt；`session/close` 还会处理 descendants、flush 持久化并销毁该会话 scope。后续子消息仍可能启动自主工作，因此用户“停止整个群任务”的语义须由宿主明确选择 cancel、close 或关闭隔离进程。原生恢复不意味着 shell/browser 等外部进程也恢复。[ACP 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/README.md#protocol-contract)、[SDK resume 边界](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/README.md#use-this-package)

ACP 不提供 fork；如果 RaytoneBot 已有自己的事件库负责历史回放，则缺少 transcript replay 本身**不是显示历史的阻碍**。原生分支若要继承 DSH 压缩上下文/工具关联，需额外调用 DSH 内核能力或自建 bridge；若以文本前情开启新会话，应在评估中明确它是重建上下文，不是原生 fork。[ACP 明确限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/README.md#known-limitations-and-deferred-work)

**Host 工具有两条已存在的扩展基础：**

- 标准 MCP：ACP 挂载 absolute-command stdio server 或 HTTP(S) Streamable HTTP server，可传受控 env/headers；连接或 discovery 失败会撤销尚未发布的 agent。适合宿主已经提供 MCP server 的场景，但 MCP client 不等于宿主已具备 MCP server，不能因此漏算工具网关开发。[MCP 挂载源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/mcp.ts)
- 专用插件：`ctx.tools.register()` 注册 schema 和执行函数；函数可调用 RaytoneBot 已有受控 host endpoint/IPC，并携带短期权限 token。这样可统一 memory/browser/routines/group 工具和结果，不必引入第二个 Web UI。[工具扩展点](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/README.md#extension-points)

标准 ACP 本身没有 elicitation、交互提问、plans 或 DSH 展示卡片。若这些由 RaytoneBot 的宿主工具负责，插件应输出既有结构化结果；若要用 DSH 原生 ask-user，则需另桥接交互 seam，不能当普通 assistant 文本完成。[ACP 不支持的表面](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/README.md#protocol-contract)

## 5. 模型网关、配置与隔离

**已证实：模型/推理档位可配置，API key 无需写进 profile。** `deepseek-official` 使用 `DEEPSEEK_BASE_URL` 或显式 `baseURL`，默认 `https://api.deepseek.com/anthropic`；API-key adapter 用 `x-api-key`，`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`。reasoning 为 off/low/high/max（受具体路由支持约束）。ACP 通过 `session/set_config_option` 设置 model / reasoning_effort，prompt 入场时固定选项，避免一轮中途切换。[endpoint/effort 配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/config.ts)、[认证实现](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek-api-key/src/index.ts)、[ACP model control](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/acp/acp/src/model-control.ts)

RaytoneBot 当前已有 Anthropic/OpenAI 两种模型租约网关，因此 **Anthropic 协议不是新架构缺口**。仍需验证租约 base URL 路径拼接、`x-api-key` 短期 token、流式 body、abort、thinking 与额外字段的转发。如果需要 OpenAI-compatible 路由，DSH 已有 `llm-pi-ai` 的自定义 `api: openai-completions` / `baseURL` / `apiKeyEnv` / `models` 配置，无需改用另一个模型。[本仓网关](../src/pi/runtime/modelGateway.ts#L96)、[多 provider 与兼容网关配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-pi-ai/README.md)

profile 应使用宿主生成的隔离配置。`DSH_HOME` 控制 sessions/config/credentials/cache 等数据，但 **不覆盖** `~/.agents`：全局 AGENTS.md 和 skills 另由 `DSH_AGENTS_HOME` 控制；此外 HOME 及调用 cwd 的 `.env` 也要纳入已有 childEnv 规则。ACP/SDK 默认的 managed credentials 优先于环境回退，因此空白专用 home 或禁用相应 credential store 更容易确保只用本轮租约。[home 双根解析](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/util/home-paths/README.md)、[各 profile 凭据差异](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/README.md#credentials)

另一个具体兼容点：默认 base profile 挂载 `session-log-deepseek`，该插件默认把未上传的 canonical Session log 作为 `dsh_session_log` 请求字段随官方 DeepSeek 调用发送，每次上限 8 MiB。若只需要普通模型调用，应在受控 profile 明确禁用该贡献，避免网关兼容问题及额外发送完整审计日志；此处是已证实默认行为，不是泛化隐私猜测。[默认组合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L43-L44)、[插件默认与关闭配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-log-deepseek/README.md)

## 6. Linux 部署与稳定性

当前源码 Node engine 要求 `^22.19.0 || >=24.0.0`；官方开发文档支持 22.19+ / 24+，CI 覆盖 22.19、24、26。npm 发布包可直接运行，不需在 sandbox 编译整个单仓。Native system 包提供 Linux x64/arm64 的预编译 Landlock executable 和 glibc/musl addon，消费安装不构建 native code。[Node 要求](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/package.json#L1-L10)、[开发支持版本](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/development.md)、[原生包](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/native/system/README.md)

DSH 自带 Linux sandbox 按 bwrap → Landlock 选择可用 runner；不可用时 fail-closed，而不是自动无隔离。实际 AgentSphere 内核、namespace/Landlock 支持及与 `raytone-agent` UID/出站边界的组合尚未实测。不要仅为让 DSH 能跑就放松宿主隔离；也不要直接采用固定 `danger-full-access` 的 `sdk-minimal` 配置作为完整产品默认。[sandbox 实现约束](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sandbox/sandbox-local/README.md)、[sdk-minimal 默认](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml#L78-L82)

上游明确标为 developer preview，并声明会有破坏兼容变更。应固定 DSH、ACP client 和自定义插件版本/commit，升级时跑契约检查；直接订阅内核 transient events 的维护风险高于只用标准 ACP。不能把这一次源码核查当成长期兼容承诺。[官方预览声明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md#developer-preview)

## 7. 尚待最小验证

这些是后续实现前的验证门槛，不是本次已经通过的测试：

1. 在既有低权限 child 环境启动固定版本 ACP；模型经现有短期租约，不读取宿主真实 key/默认配置。
2. 一次读取、一次写入、一次 shell、一次 host/MCP tool：确认 callId/参数对应，审批拒绝前零副作用，取消审批不继续。
3. 正常完成、模型错误、tool error、取消长命令、杀进程后 resume；确认历史、退出原因、租约释放、后台子进程清理。
4. 持久化后重启并 resume 同一 session；未知 id/错误 cwd 必须报错，不静默换新对话。
5. 若要实时体验，加入 delta/commit/abandon 重试样本、PTC 内层工具和 shell output gap；用既有 PiAdapter fixture 验收全部状态。

## 8. RaytoneBot 的实际改动范围

以下是基于当前源码的改动评估，不是已实施内容。保持 ADR-009 的子进程适配方向和 ADR-025 的现有组件边界。

| 范围 | 复用与需补内容 | 复杂度 |
| --- | --- | --- |
| 引擎运行 | 在 `src/pi/` 增加专用 DSH runner/协议翻译模块，接入 `piHost.runCliPrompt` 的分支；复用 runId、停止、审批、事件落盘、运行上限。无需先抽象通用引擎框架 | 中 |
| 事件展示 | DSH → PiWireEvent → piAdapter → AgentUX → 现有 ChatFrame/OutputFrame；工具名和参数规范化，审批 callId 关联，结束/失败/取消与重试去重。高实时性需要上文 transport 扩展 | 中高 |
| Bot 与入口 | `AgentHarnessId` 和 preset 目前各有三个固定值，BotProfile 存 presetId。增加 DSH 需补枚举、配置校验、名字/头像映射、创建 Bot 的引擎选项、引擎状态和标识、工作区与身份提示；保留现有 Bot 的不可变引擎和旧对话兼容 | 中低 |
| 统一权限与模型 | 使用现有 approvalGate/permissionPolicy、scrubSecretEnv、spawnAgentProcess 和模型租约；增加受控 DSH profile/pre-execute 插件。必须核对临时 HOME 处理，当前相关 helper 仍有 Codex 专用路径约束 | 中高 |
| 宿主工具 | 复用 `hostToolsFor` 与现有 web/MCP 工具执行函数，通过受控 IPC/插件转发；memory、browser、publish_artifact、用户提问、routines、group 等仍由本产品负责。现有 CLI 协议内的 MCP 桥不能不加转换就给 ACP 使用 | 中 |
| 原生上下文与历史 | 泛型 cliSession 可保存 DSH session id；checkpoint/branch 类型及校验需扩充。前端历史由自有事件库回放；原生分支应有可靠边界，否则首版明确不支持，不能用渲染文本假装原生续接 | 中高 |
| 部署和恢复 | 当前云端 Node 24 满足上游版本要求；增加固定包版本/启动检测、受控 home/配置、会话数据备份白名单及恢复权限。保留低权限 UID、现有出站与模型代理，实测 DSH 原生 sandbox 的组合 | 中 |
| 贯通验收 | 新 Bot 经现有 runPrompt 进入网页、群聊、IM、例行任务；各处固定 preset 校验都要覆盖。验证停止仅影响本轮、重启不自动重放、备份恢复后能续接，补现有 fixture 和必要集成测试 | 中 |

本仓定位：

- [引擎与 preset](../src/pi/harnessCatalog.ts#L8)、[Bot 身份/不可变绑定](../src/runtime/botProfiles.ts#L4)、[Bot 创建选择](../src/components/shell/BotEditor.tsx#L56)。
- [运行分支与共用审批](../src/pi/piHost.ts#L591)、[宿主工具集合](../src/pi/piHost.ts#L324)、[既有 CLI 运行合同](../src/pi/cliHarness.ts#L30)、[Pi 事件映射](../src/harness/adapters/piAdapter.ts)。
- [模型租约与思考档位](../src/pi/runtime/modelGateway.ts#L21)、[执行 UID 与 HOME](../src/pi/runtime/agentProcess.ts#L39)、[密钥剥离](../src/pi/runtime/childEnv.ts)。
- [原生分支及硬编码校验](../src/pi/conversationBranch.ts#L6)、[工作区布局](../src/pi/workspaceLayout.ts)、[备份白名单](../scripts/agentsphere/backup_data.py#L20)、[安装隔离](../scripts/agentsphere/setup_isolation.py#L38)。

一个已确认的具体冲突：本仓模型网关请求体上限 4 MiB，而 DSH 的 session-log 插件每次可添加最多 8 MiB 日志。因此受控 profile 应关闭不需要的 session-log 贡献，而非直接扩大网关限制。保留原有模型选择，DSH 每轮只能拿本次模型的短期租约；恢复进程后必须重新发租约，不能依赖过期 token。

## 9. 建议实施顺序与验证边界

1. **先验证协议和权限。** 固定 DSH 版本，受控 profile，普通工具模式；完成第 7 节的拒绝/停止/resume/租约测试。若审批不能覆盖实际执行路径，先解决桥接，不能用全允许模式冒充接入成功。
2. **再做最小可用入口。** 在现有创建 Bot 流程加入 DSH，映射事件并接通基础宿主工具；完整用户提问、群聊和其他入口按真实验收进度开放。第一版可按 step 出文字，原生分支保持明确不可用。
3. **按验证收益补实时与复杂能力。** 增量事件、工具实时输出、PTC、子 agent、原生分支分别有独立兼容面，逐项补齐后再启用。上游版本升级单独验证，不跟随 latest 自动更新。

实施时最窄验证为新增协议/审批/恢复测试与 build；动到主机再跑 check:local，涉及部署再跑 cloud-preview --check 和独立 Linux 环境验证。事件适配完成后走查全部内置 fixture，并做至少一轮真实 DSH 的读文件、批准/拒绝写文件、产物、停止、重启续接和宿主工具任务。三种既有引擎保留回归覆盖。

本次只新增此评估文档，检查了源码引用和文档格式；未改运行代码、依赖、默认模型或配置，未运行构建/测试或声称 DSH 已接通。上游正式运行兼容性、资源占用、真实模型效果和 Linux 双层隔离仍待上述技术验证。
