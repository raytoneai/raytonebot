# Agent 主动请求登录信息：安全输入卡方案

日期：2026-10-25。下文保留设计阶段的建议与当时的代码差距；用户随后批准实施，现已接入主机安全请求与既有审批卡，见[验收记录](../output/vault-secure-input-2026-10-25/README.md)、ADR-053。官方证据见[专题研究](grokbot-secure-form-2026-10-25.md)。

## 推荐交互

Agent 从当前网页判断登录是完成用户任务所必需的，调用现有 `vault_request_use(snapshotId, passwordRef, usernameRef?)`。主机验证实际 HTTPS 页面和字段，再在聊天中显示现有审批卡的登录输入状态。无需用户先去 Settings，也不让 Agent 自行输出 HTML 表单。

- 有匹配项：选择已保存登录，也可选择「使用其他账号」进入输入状态。该切换是本项目建议，并非已核实的 Grok UI。
- 没有匹配项：直接显示用户名、密码，网站由主机固定，不可由模型或表单修改。
- 用户可勾选「保存到 Vault」，默认不勾；勾选时可填名称。保存选择与本次填充授权分开记录。
- 主按钮「授权并填充」，副按钮「取消」，另提供原有浏览器接管入口。一次提交同时提供所需信息并明确授权本次填充，不再额外弹同意卡。
- 填入后仅报告状态，继续现有接管提交流程，不自动登录。后续请求仍需逐次授权。

建议卡片内容（不是 Grok 截图或精确复刻）：

```text
需要登录信息
Raer 请求将登录信息填入 https://example.com

用户名  [                    ]
密码    [ •••••••••••••••••• ]
□ 保存到 Vault

用户名和密码直接交给主机，不进入聊天记录或模型上下文。
目标网站在填入后可以读取这些信息。本次只填充，不提交登录。

取消                     授权并填充
```

普通信息（偏好/选项/文本）、动作授权、秘密输入仍分别处理：普通信息用 `ask_user`；操作权限由既有 permission gate/approval 控制；登录凭据用安全输入卡。OAuth、验证码和不支持的登录页面使用浏览器接管。此轮不扩展为通用 API key、卡片或任意秘密输入服务。

## 如何告知 Agent

工具能力必须先实现，再同时更新 `vault_request_use` 的 description、`productFaq.ts` 的每轮说明和 `browserTools.ts` 的登录指引。不要仅在角色提示词里承诺尚不存在的弹窗。三类指引保持一致，所有引擎经当前 HostTools 通道获得同一工具契约；旧 Codex 原生线程是否已有工具须核对，不能靠修改提示词假定其 dynamicTools 已更新。

建议指引：

> 当完成用户当前任务确实需要登录时，先查看浏览器最新页面。对支持的登录框调用 vault_request_use，传入当前 snapshotId 和字段 ref。主机会让用户选择已保存凭据，或显示安全输入卡；你不需要知道是否已保存账号，也不得索要聊天中的用户名/密码。等待工具结果，用户取消或请求过期时停止该登录步骤。filled 只表示已填充，随后请用户接管检查并提交；结果不确定时不得自动重试。页面不支持时请求浏览器接管。

模型输入契约继续只有页面引用和可选 itemId，不接受 password、username、任意目标 URL、任意字段 schema 或由模型控制的秘密提交地址。是否保存只能由用户在受信任卡片中选择。模型只得到 `filled / denied / expired / unavailable / unknown` 等状态及必要的非秘密保存结果。

## 仓库差距与最小改动

| 位置 | 当前事实 | 建议变化 |
| --- | --- | --- |
| [vaultUse.ts](../src/pi/vaultUse.ts) | 无匹配登录直接返回 unavailable，并要求去 Settings；已保存项走普通选择题 | 无匹配项进入专用凭据请求；有项支持选择或新输入；保留当前一次性目标校验 |
| [channelSetup.ts](../src/pi/imChannels/channelSetup.ts)、[useChannelSetup.ts](../src/runtime/useChannelSetup.ts) | connect_channel 已有值直接 POST 主机、事件不含秘密的路径 | 借鉴生命周期与专用 POST 模式，Vault 独立处理登录，不把用户名/密码冒充频道 token |
| [approval.tsx](../src/components/agent-preview/chatframe/approval.tsx) | 已有 secret 掩码输入，但所有 answerPlaceholder 共用一个 answer 字符串 | 给现有 owner 加可选、分别受控的表单字段与保存勾选；保留既有单输入默认行为。不能直接放两个 answerPlaceholder，否则两个框会共用同一个值 |
| [piAdapter.ts](../src/harness/adapters/piAdapter.ts)、[agent-shell.tsx](../src/agent-shell.tsx) | channel_setup 仅把非秘密状态投射为 run.awaiting_input，shell 交给现有卡片 | 类似增加 Vault 请求/结束状态，复用 awaiting-input 与 inputRequestId，不新增平行弹窗组件 |
| [userInputDraft.ts](../src/runtime/userInputDraft.ts)、[userInput.ts](../src/runtime/userInput.ts) | 普通回答保存在 sessionStorage，adapter 还把它写成用户消息 | 秘密输入完全绕开该链路；普通问题保持原逻辑 |
| [piClient.ts](../src/pi/piClient.ts)、[piHost.ts](../src/pi/piHost.ts) | Vault 管理和授权回答已有接口，输入值没有运行时请求专用接口 | 建议 `POST /__agentcanvas/pi/vault/requests/:requestId/answer`，绑定 conversation/run/bot、同源检查、一次性请求与并发锁；只回状态 |

拟议事件可用 `run.awaiting_input` 的 `vaultRequest` 元数据分支，字段仅有 requestId、来源、候选条目和阶段；不能包含表单值。对应状态 hook 放 `src/runtime/`，草稿只保留当前请求的组件内存，切换会话/请求、取消、提交成功、停止、超时清空；刷新可恢复仍活跃的请求卡，但需重新输入。

## 保存、授权与失败语义

- 复用当前 120 秒有效期与 conversation/run/bot、页面/快照/控制权/DOM 节点绑定；这是本项目规则，不能说是 Grok Secure Form 的 TTL。输入期间页面或控制权变化，提交拒绝，不自动向新页面填入。
- 未勾选保存：仅供这次请求，在填充/取消/过期后释放引用，不写 Vault 或普通会话存储。浏览器已填值和现有输出脱敏所需的短期内存不能承诺被立即物理擦除。
- 勾选保存：提交时先验证请求和页面，保存到现有 `VaultStore` 并取得版本，再执行当前版本绑定的填充；保存失败不填。若已保存而后续填充失败，明确显示「已保存，未确认填充」，不声称两项操作原子成功、不自动重放。不能直接覆盖同名/同站点旧条目；编辑仍在 Settings。
- HTTP 重复提交返回同一请求的非秘密结果，不能再次填充。取消/停止和迟到响应不能把旧请求复活。409 等可恢复失败保留当前卡草稿，但不得自动重试写入。
- 密码原样保留，不 trim；沿用 Vault 长度约束（用户名 512、密码 8192），不能继承普通问答 4000 的统一上限。服务器错误使用固定文案，日志/事件/模型/草稿存储不得包含值。
- allow-all 仍不能跳过凭据授权；IM/群聊保持不开放。本机同 UID、恶意目标网页、云端隔离与备份恢复的已知限制继续适用。

## 实现后验收

1. 新账号：Agent 调用工具 → 卡片输入 → 不保存填充 / 勾选保存填充 → Settings 可见并重启恢复。
2. 已有账号：选择条目 / 使用其他账号；授权拒绝、取消、过期、停止、导航、接管与条目删除/编辑不填充。
3. 两字段独立，密码空格与 Unicode 保真，失败提示不泄漏；关闭/切换/刷新无秘密草稿残留。
4. request/auto/allow-all 均须点击授权；重复提交只填一次；填充后不提交且保留既有输出保护。
5. 检查事件/对话历史/模型请求/日志/localStorage/sessionStorage/未勾选时的磁盘均无虚拟秘密；受控模型端点检查工具契约，真实 Chromium 检查字段落值。
6. 用真实 Agent 在合成页面验证能自主选对工具；再做 Settings/既有 Telegram 安全输入/普通问答/审批/内置场景回归。与仅 HTTP 主机集成测试区分记录。

调研阶段仅核对代码；后续实现与实际验证范围以链接的验收记录为准，未做的真实模型自主选工具验证不算通过。
