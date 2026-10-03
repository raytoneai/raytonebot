# nightly-labs/openbot 借鉴判断

2026-10-02 核对发布版 `v0.27.0`，commit `795b3fd894acc7a4e41574763623b2c0aae4fb73`。这是 nightly-labs 的项目，与前次调研的 CopilotKit/OpenBot 无关。本次仅阅读官方发布、文档和源码，没有安装、启动或复制实现到 RaytoneBot。

## 判断

作为“本机起步、云沙箱运行、持久个人助手”的产品和运行机制参考，它比 CopilotKit 的演示模板更贴近目标。作为预计商用的代码底座，不应直接采用：该版本是 PolyForm Noncommercial 1.0.0，而非 MIT；商业复用需另获合适授权。[许可](https://github.com/nightly-labs/openbot/blob/v0.27.0/LICENSE)。

最新应用版本在 2026-10-01 发布；README 仍标注 development preview。连续发布和已列出的测试记录证明项目在积极开发，不能据此推断所有功能已经稳定。[发布记录](https://github.com/nightly-labs/openbot/releases/tag/v0.27.0)、[README](https://github.com/nightly-labs/openbot/blob/v0.27.0/README.md)。

## 最值得独立实现的行为

| 现有设计 | 对 RaytoneBot 的价值 |
| --- | --- |
| 每个 Agent 有自己的工作目录、对话、模型和配置 | 让助手成为可持续使用的工作对象；初版可只提供一个 Agent。 |
| SQLite 保存会话、队列、附件和 provider session 绑定 | 补上当前内存会话的缺口；业务会话 ID 与模型运行会话分离，后续更换运行时不丢历史。 |
| 队列支持暂停、取消、恢复；重启后的不确定任务标记中断 | 防止断线/崩溃后自动重发导致重复写文件或调用外部工具。 |
| 同一产品连接本机和远端执行主机 | UI 保持一致，让执行位置成为明确的用户选择。 |
| 云沙箱停机留盘、访问唤醒、定时任务前唤醒 | 降低闲置成本，并使电脑关机后任务仍可运行。 |

证据：[状态归属与远端结构](https://github.com/nightly-labs/openbot/blob/v0.27.0/docs/ARCHITECTURE.md)、[provider session 存储](https://github.com/nightly-labs/openbot/blob/v0.27.0/src/backend/database/provider-sessions.ts)、[重启恢复测试](https://github.com/nightly-labs/openbot/blob/v0.27.0/src/backend/agent-service.restart.test.ts)。测试是源码证据，本次未运行。

## 与当前技术路线的差异

- 它是 Electron + SolidJS 的桌面应用，拥有 Web/React Native 客户端和 Bun workspace；AgentCanvas 是 React/Vite。不能把它的 UI 组件直接装入当前项目。[架构](https://github.com/nightly-labs/openbot/blob/v0.27.0/docs/ARCHITECTURE.md)。
- Agent 层接 Codex App Server、Claude Code 与 ACP providers，有自己的事件、存储和远程协议。它不是 Pi 或 AgentUX 的现成替换件，也不采用前述 CopilotKit Intelligence 作为本地执行底座。[provider 实现](https://github.com/nightly-labs/openbot/blob/v0.27.0/src/backend/provider-drivers.ts)、[客户端边界](https://github.com/nightly-labs/openbot/blob/v0.27.0/src/backend/agent-client.ts)。
- README 明示底层 Agent 使用 `danger-full-access` / `approvalPolicy: never`。不能把这套执行默认值照搬到 RaytoneBot；保留现有修改类工具审批。应用层仍有特定确认/人工接管，不应把 README 的底层策略理解为整个产品完全没有审批。[README](https://github.com/nightly-labs/openbot/blob/v0.27.0/README.md)、[状态与审批归属](https://github.com/nightly-labs/openbot/blob/v0.27.0/docs/ARCHITECTURE.md#state-ownership)。

## Cloud Sandbox 的直接参考价值

它已经接入 boat：沙箱运行 Linux 版 OpenBot，配合桌面环境与系统服务；账号 Worker 管理沙箱生命周期、D1 状态、定时唤醒，售卖托管服务另接 Stripe。远程连接还涉及账号、Signal 与 TURN。这个形态比当前 Node/Pi 原型复杂，不是通用云沙箱 SDK。[托管说明](https://github.com/nightly-labs/openbot/blob/v0.27.0/docs/hosted-servers.md)、[boat 客户端](https://github.com/nightly-labs/openbot/blob/v0.27.0/apps/auth-api/src/server/boat-client.ts)。

官方记录了 boat 启停、保留文件和扩缩配置的实测，也明确列出未确认的丢失响应、真实 Agent 内存保护和长时间运行等场景。不能推定这些结论适用于我们的 Cloud Sandbox。[测试与未确认项](https://github.com/nightly-labs/openbot/blob/v0.27.0/docs/hosted-servers.md#tested-on-boat)。

## 建议顺序

保留 AgentCanvas UI 与当前 Pi 运行时；首先独立补 SQLite 历史、任务状态和安全的中断恢复。拿到云沙箱文档/key 后，再按平台能力接执行与文件边界，并借鉴停机保留数据/按需唤醒的行为。多 Agent 协作、远程桌面、插件市场和收费控制面暂不引入。

这一建议针对快速实现 RaytoneBot，不把 nightly-labs 的源码导入当前工程，也不假设已获得商用授权。
