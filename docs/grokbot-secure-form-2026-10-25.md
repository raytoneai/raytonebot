# Grok Bot 安全表单：公开交互与证据边界

核验：2026-10-25（Asia/Shanghai）。承接 [Vault 一手来源核验](grokbot-vault-primary-sources-2026-10-24.md)。仅核对公开官方文档，未操作真实账户、抓包或审计实现；以下是研究事实，不是已采纳的产品要求。

## 已确认

| 问题 | 官方公开行为 |
| --- | --- |
| 谁发起、何时出现 | 登录先用 Vault，再用已连接的密码管理器；都没有时，Bot 询问 Secure Form。[Secrets](https://cursor.com/help/grok-bot/secrets) |
| 输入后是否保存 | 表单可勾选保存到 Vault；不勾选则仅用于该聊天，值会自动过期。[Secrets](https://cursor.com/help/grok-bot/secrets) |
| 表单怎样对应网页 | Bot 可在聊天中逐步展示表单，每步一个，替用户把回答填入网页；例子包含登录、结账地址和电话。[Approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy) |
| API key 是否相同 | API key 等另走遮罩的 secure secret card，提交后显示已保存，值不写入聊天。不能把它直接等同于 Login 的 Secure Form。[Secrets](https://cursor.com/help/grok-bot/secrets) |
| 模型可见范围 | 官方称已存密码、卡号、安全码对 Bot 不可见；联系资料及有哪些登录可见。secure secret request 的值不进 transcript，也不提供给模型。[Secrets](https://cursor.com/help/grok-bot/secrets)、[Approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy) |
| 填充失败 | 页面变化可能导致填充失败；官方说明值仍不展示给 Bot，若 Bot 再次请求则提交新卡片。保存失败有独立失败提示。[Secrets](https://cursor.com/help/grok-bot/secrets) |

### 已有凭据的选择：证据只到这里

内建 Vault 的文档描述由 Bot 挑选合适条目，并允许用户提供使用提示；**没有说明 Secure Form 内一定存在“选择已有 Vault 条目 / 输入新值”的切换界面**。保存可选，不等于已证实用户在同一张表单里选择来源。[Secrets](https://cursor.com/help/grok-bot/secrets)

1Password 的选择流程则写得明确：Vault 没有登录时，聊天卡片标明网站；用户打开 1Password，选择具体登录项并批准，由 1Password 填入 Bot 浏览器。已分享项后续聊天仍可用，权限失效再请求。这个选择界面属于 1Password，不能作为内建 Vault 的 UI 证据。[Connect apps](https://cursor.com/help/grok-bot/connect-apps)

### 输入、授权与取消不能混为一谈

- **输入请求**提供缺少的信息；**动作审批**决定待执行操作能否运行。官方 FAQ 明确区分 secret card、应用登录、密码输入与 Auto Review 审批。[How Tos](https://cursor.com/help/grok-bot/how-to)
- 动作审批提供单次允许、持续允许规则和拒绝。正在参与的聊天审批等待用户；由 routine、trigger 或其他 Bot 启动的工作，其审批约十分钟后过期，动作不运行。过期后新增允许规则也不会补执行旧动作。[Approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- 人工接管的登录流程可选择 Skip；审批可 Deny，FAQ 称拒绝后直到用户再发消息才重试该动作。两者都不能证明 Secure Form 有同名按钮或相同取消语义。[How Tos](https://cursor.com/help/grok-bot/how-to)
- 用保存的卡片之前会询问用户；官方未在这些资料里规定所有内建 Vault 登录均需逐次审批。[Secrets](https://cursor.com/help/grok-bot/secrets)

## 未公开，不能按已实现描述

本次核对上述官方资料，未找到下列细节：

1. Agent 发起 Secure Form 的正式工具名、参数 schema、结果事件，以及请求如何绑定聊天、run、网页与字段。
2. 同表单选择 Vault 条目或新输入的布局、候选项展示、保存复选框默认值，以及没有匹配项时的界面。
3. Secure Form 等待时限；未保存值的具体 TTL、计时起点、到期清除机制。**只确认自动过期，不能填写“十分钟”。**
4. 表单取消、关窗、Stop、断线、页面跳转后，对 pending 请求和已输入值的处理；是否自动重试、是否保留草稿。
5. 输入提交是否同时授权登录提交，以及填充、保存、提交网页之间的原子性或先后顺序。
6. 密码学、DOM/截图/工具输出防回显和精确网站匹配的实现。文档中的“模型不可见”是产品公开承诺，不能当作独立实现验证。

对 RaytoneBot 的设计含义：可以参考“Agent 发现缺项 → 请求安全输入 → 用户可选择保存 → 执行后回报状态”；若加入“已有 Vault / 新输入”选择、取消策略、TTL 或具体工具协议，应明确作为本项目自行定义的行为。

## 核验记录

- 阅读上列官方原文，交叉检查 [电脑使用说明](https://docs.x.ai/grok-bot/computer-and-apps) 与 [官方 changelog](https://x.ai/changelog/bot)；不以论坛用户描述确定工具接口或当前实现。
- 已有 Vault 专题比部分接管概览更具体；概览缺项不代表能力不存在。
- 仅新增本文；文档检查：`git diff --check -- docs/grokbot-secure-form-2026-10-25.md`。未运行应用测试。
