# Grok Bot Vault：一手来源核验

核验日期：2026-10-24（Asia/Shanghai）。范围：公开产品文档，不是客户端抓包、代码审计或安全认证。本文是研究依据，不构成已采纳的实现要求。

## 已确认的产品事实

官方 changelog 在 **2026-10-23 的 v0.75.5** 条目宣布 Vault，可保存登录、卡片和联系资料，并用于登录或结账；该能力要求 **Grok Bot 0.75.2 或更高版本**。这是公开宣布日期，不能据此断言所有账户的实际开放时刻。[Grok Bot Changelog](https://x.ai/changelog/bot)

以下细节来自 x.ai 官方电脑使用文档直接链接的 [Store secrets securely](https://cursor.com/help/grok-bot/secrets)：

| 项目 | 官方说明摘要 |
| --- | --- |
| 内建 Vault | 桌面和手机的 Settings → Vault，三类条目为 Login、Card、Contact info；不支持 Team Bots。 |
| 模型边界 | 密码、卡号、安全码不向 Bot 展示；联系资料和已有登录条目可供 Bot 选择使用。保存后的密码不可读回，卡仅显示末四位。 |
| 输入 | 设置中新增，或 Secure Form 勾选保存；未勾选的表单值仅保留于该聊天并自动过期。支持卡片照片、桌面 CSV 导入。 |
| 使用 | 登录优先 Vault，再查连接的密码管理器，最后询问 Secure Form；生成新账户密码也可由 Vault 完成。用卡前询问用户。 |
| 维护 | 密码、用户名、网站和卡片敏感值在设置中修改；Bot 可修改联系资料、昵称和提示。 |
| API key | 走独立 secure secret card，遮罩输入、不写入聊天；Team Bot 的 Secrets 亦不是个人 Vault。 |

该页明确把卡片的 security code 列为字段。这是产品公开行为描述，**不是**其合规或底层存储实现证明。[同页](https://cursor.com/help/grok-bot/secrets)

## 1Password 集成是另一条路径

Grok Bot 的 [Connect apps](https://cursor.com/help/grok-bot/connect-apps) 描述了新的、逐步开放的 1Password 集成：支持个人及 Family 账户，要求 1Password 8.12.42+；选择具体登录项并批准后由 1Password 填入，Bot 不见值。已分享登录可用于后续聊天，权限失效则再次请求。当前只提供 Personal/Private vault 的登录；**此 Grok Bot 集成不填支付卡**，也不再使用旧的 service account 方式。不能把旧论坛中“Shared with Grok Bot vault + service account”当作当前方案。

文档既概括“approve each login”，又说明已分享项跨聊天可用；它未清楚定义“每次填充是否都弹审批”的全部情况，不应自行强化为每次必弹。[Connect apps](https://cursor.com/help/grok-bot/connect-apps)

## 安全边界与尚未公开的细节

- x.ai 说明 secure secret request 的值被遮罩、排除在 transcript 外且不展示给模型；对敏感操作也保留接管电脑的路径。Auto Review 是模型判断，官方明确其应配合最小权限和用户设定的动作边界。[Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- 同一用户的 Bots 共享电脑、浏览器会话和文件；不同屏幕不构成安全隔离。因此，密码不进入模型不等于登录会话只属于一个 Bot。[Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- 上述公开资料没有给出 Vault 的加密算法、主密钥位置、端到端加密/零知识保证、密钥恢复和轮换、删除后的备份处理、解锁 TTL、截图/DOM/网络回显防泄漏机制。这些都应标为**未知**。
- 已确认 Login 带网站、CSV 导入要求 HTTPS；未找到内建 Vault 关于精确 origin、子域、端口、重定向、跨域 iframe 的匹配算法或强制执行说明。不能把“用于该网站”扩写成“经过严格域绑定验证”。
- 帮助中心已有新 Vault 细节，部分 x.ai 概览仍以人工接管为主，Settings 页面也未完整列出 Vault。产品文档存在更新节奏差异；具体功能以明确的更新日志和专题帮助为依据，不能将概览缺项解释成能力不存在。

## 可用于设计比较的一手参考

1Password 浏览器扩展在填充前要求用户操作，对登录 iframe 校验其来源，对信用卡填充显示页面无法遮盖的确认提示。它也明确：秘密一旦填入网页，网页上的风险仍然存在。这些是 **1Password 扩展**的行为，不能移植为 Grok Bot Vault 已实现的事实。[Autofill security](https://support.1password.com/browser-autofill-security/)

1Password 的默认站点建议可跨子域及已知关联网站，也提供严格匹配 host（包含端口）的选项；说明“域绑定”需要写清具体规则，而不是一个布尔开关。[Autofill behavior](https://support.1password.com/autofill-behavior/)

PCI SSC FAQ 1574 区分了服务商代消费者保存（明确包含 password vaults）与消费者在自己的设备上输入自己的卡资料；后者不在该 FAQ 讨论范围。前者不能为后续交易保留卡安全码。FAQ 1280 还说明，在其适用场景中，加密或消费者同意不使授权后保留安全码变得可接受。不能仅凭本仓库“单用户”“本地”就确定所有未来云部署的适用结论。[FAQ 1574](https://www.pcisecuritystandards.org/faqs/1574/)、[FAQ 1280](https://www.pcisecuritystandards.org/faqs/1280/)

对 RaytoneBot 的研究建议：先把不让模型接触秘密、明确目标后填充、用户可撤销的权限边界作为产品能力；信用卡及安全码是否持久化应独立决策。现有文档不足以直接复制 Grok Bot 的密码学设计或认定其卡片实现适合本项目。

## 验证记录

- 已打开并阅读上述原始页面，未依赖搜索摘要或社区帖子确认当前实现。
- 仅新增研究文档；未运行应用、创建凭据或改动运行时。
- 文档检查：`git diff --check -- docs/grokbot-vault-primary-sources-2026-10-24.md`。
