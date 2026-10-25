# 用户 Vault：Grok Bot 调研与 RaytoneBot 实施建议

日期：2026-10-24。调研代码基线：`63ebe77` 的当时工作区。下文保留调研时的现状与建议；用户随后批准登录凭据范围，2026-10-25 已完成本机实现，见 [ADR-052](product/07-decisions.md#adr-052登录-vault-由主机保存与逐次授权填充2026-10-25) 与[验收](../output/vault-2026-10-25/README.md)。信用卡未做，未部署，没有读取或使用真实秘密。

## 结论

可以在现有 Node host、SettingsDialog、审批卡和 Playwright 浏览器上做，不需要新后端、数据库或第二套浏览器。建议首版做「保存网站登录凭据 → 用户批准一次 → 主机直接填入指定网站」，随后补联系人，最后单独评估信用卡。

难点不是加密文件，而是让 Agent **有权使用某项凭据，却拿不到明文或任意导出能力**。现有 Provider 存储可以借鉴，但还不是通用用户 Vault。本机同 UID 与 AgentMatrix 当前隔离缺口必须作为发布条件处理，不能因实现了 AES 就宣称密码对 Agent 不可见。

## Grok Bot 的可核实范围

官方详细证据、查询限制与 PCI 范围见[一手来源笔记](grokbot-vault-primary-sources-2026-10-24.md)。官方入口是 [Grok Bot changelog](https://x.ai/changelog/bot) 和 [Secrets 帮助页](https://cursor.com/help/grok-bot/secrets)；后者由 xAI 官方文档链接。

- 内建 Vault 保存登录、支付卡和联系人；既可从设置管理，也可在安全表单中选择保存。
- 官方区分密码/卡号/安全码与普通联系资料的模型可见性；不能笼统概括成「所有 Vault 数据都不进模型」。
- 1Password 是另一个来源选项，不等于内建 Vault 的存储实现。
- 用户可见的功能说明不能证明具体密码学、密钥托管、备份或隔离实现。本文不推定 Grok 使用某种 AES/KMS/零知识架构。

## 仓库现状：可以复用什么

| 能力 | 已有代码和边界 | Vault 所需变化 |
| --- | --- | --- |
| 主机加密存储 | [providerStore.ts](../src/pi/providerStore.ts)：AES-256-GCM、随机 nonce、版本 AAD、文件权限校验、原子替换、revision/并发冲突、损坏时拒绝覆盖；GET 仅返回是否已设置 | 独立的用户凭据模型和文件，借鉴这些机制；不把用户密码塞进 provider connections |
| 安全输入 | [channelSetup.ts](../src/pi/imChannels/channelSetup.ts)、[useChannelSetup.ts](../src/runtime/useChannelSetup.ts)：密码输入直接 POST 主机，事件/工具结果只报告状态 | 复用输入流模式，绑定请求身份；密码不能经过普通消息或问答草稿 |
| 管理入口 | [SettingsDialog.tsx](../src/components/settings/SettingsDialog.tsx) 已有设置分区及可选 props | 增加 `vault` 分区，沿用列表/编辑/删除；静态 fixtures 缺少 props 时保持兼容 |
| 多引擎工具 | [piHost.ts](../src/pi/piHost.ts) 的 `hostToolsFor`；CLI/DSH 共用 HostTools 通道 | 注册只有引用和目标的工具，保持所有引擎相同的主机授权逻辑；不新增引擎专属 secret 通道 |
| 浏览器执行 | [browserService.ts](../src/pi/browser/browserService.ts)、[browserWorker.ts](../src/pi/browser/browserWorker.ts)：动作串行、接管、页面/快照归属、执行前重查 | 新增主机专用填充操作；普通 `browser_type` 继续拒绝秘密 |
| UI 状态 | [approval.tsx](../src/components/agent-preview/chatframe/approval.tsx)、Output 浏览器来源 | 扩展已有 owner 展示安全请求、确认/拒绝、失败；不建 Vault 弹窗或第二个浏览器 |

不能直接照搬的细节：Provider key 校验拒绝空白并 `trim()`，密码可能合法包含空格，必须按原字符保存；Provider endpoint 绑定也不等于网页登录的页面/frame origin 绑定。

普通 [userInput.ts](../src/runtime/userInput.ts) 明确拒绝秘密问题，[userInputDraft.ts](../src/runtime/userInputDraft.ts) 将普通问答存入 sessionStorage。Vault 安全输入应沿用 channelSetup 的独立提交路径，不能仅把普通问答输入框改成 `type=password`。

## 三个必须先解决的边界

### 1. 加密保存不等于 Agent 隔离

Provider 默认把 `master.key` 和密文放在同一个受保护目录；复制整个目录或控制主机 UID 可以解密。现有 [childEnv.ts](../src/pi/runtime/childEnv.ts) 过滤环境变量、permissionPolicy 拒绝秘密路径，是防误用措施，不能替代 OS 隔离。

本机还有独立问题：[requestOrigin.ts](../src/pi/requestOrigin.ts) 接受没有 Origin 的客户端请求。它符合当前「本机同用户已受信任」假设，却不能鉴别 Agent shell 与用户浏览器。即使密钥改放 Keychain，同 UID 进程、可调用主机端点和可访问 CDP 的问题仍在。

建议的可用范围：

- 开发阶段：本机只用虚拟凭据；暂不宣称对不可信 Agent 隔离。
- 首个真实凭据闭环：优先在 AgentSphere 已有独立 host/agent/browser UID 路径实现，额外验证 Vault 管理端点、确认端点、密钥目录、IPC/CDP 均不可由 Agent UID 越权访问。已有部署标记不足以代替实测。
- AgentMatrix：先补相同隔离与恢复证据，再开放真实凭据使用。
- 如必须首发本机：需要明确加入受限 Agent 执行环境/受保护的用户授权边界；Keychain 是密钥保管的增强项，不能独自解决全部问题。这是额外工程范围。

### 2. 现有审批模式不够

[approvalGate.ts](../src/pi/approvalGate.ts) 的 `requiresApproval()` 在 `allow-all` 下会跳过 `outward`。因此不能只是把 `vault_use` 标成 `outward`，更不能把 `secret` 全局改成可批准。

建议 Vault use 在主机内部有独立的一次性授权检查，使用原审批卡呈现；不受 `auto`、`allow-all` 或旧的「始终允许」覆盖。绑定 `requestId + botId + conversationId + runId + itemId/version + pageId + document/snapshot revision + exact origin + 操作`。修改凭据、导航、换页、停止、超时和重启均使授权失效。服务端从活跃 run 获取调用身份，不能信模型传来的 botId。

「允许填入账号密码」不表示允许购买、支付、OAuth 授权或修改账号。涉及后者继续取得对应动作授权；未来若支持卡，最终支付必须在所有权限模式下确认商户、金额、币种。授权 UI 可复用，授权条件需要专门实现。

### 3. 填完后仍可能从页面泄露

当前快照会按敏感输入字段打码，但正文、标题、URL、dialog、错误信息、下载以及截图是其他出口。现有截图帧主要送给 Output 用户视图，不等于已发送模型；任何后续模型视觉输入必须另有过滤边界。

指定 origin 上的网页及其脚本在填充时会收到秘密，即使没有点击提交。域名匹配无法防御目标网站本身被攻陷，也无法保证恶意页面不把密码编码、拆分后显示出来。因而承诺应是「秘密不通过工具参数、结果、日志和模型通道直接传递」，不能宣传成防御任意恶意网站的绝对保证。

需对敏感填充阶段限制模型观察/并发动作，输出只给状态；针对支持的网站和输出通道实测回显防护。可信目标、浏览器进程和主机属于信任边界，秘密值替换只能是补充防线。

## 建议的最小闭环

1. 用户在 Settings → Vault 添加「GitHub 工作账号」，录入精确 HTTPS origin、用户名、密码。密码只在表单内存中暂存，直接提交 host；保存后清空；首次不提供明文回读/复制/批量导出。
2. Agent 执行用户请求，打开登录页。它调用 `vault_request_use`，参数只含用途、目标页面和可选 itemId；不含密码，不允许模型调用 `get_secret`。
3. 主机根据浏览器真实目标筛选条目，卡片显示网站、条目别名、使用目的和「仅此次允许 / 拒绝」。默认由用户在卡片选择具体账号，避免把整个 Vault 清单发给模型。
4. 没有条目时，用同一安全输入路径补充，可选择「仅本次使用」或「保存供以后使用」。IM 只引导到已鉴权网页，绝不在聊天收密码；无人值守 routine 无人批准就不填。
5. 批准后，主机校验仍是同一 run、页面和条目版本，短暂解密，经已有私有 IPC 直接交给 browser worker。worker 在执行前重查 HTTPS origin、文档、字段类型和目标归属，再填入；不生成含明文的工具调用，不自动提交。
6. 工具只返回 `filled / denied / expired / unavailable` 等固定状态；填充成功不等于登录成功。后续观察登录状态，验证码、Passkey、CAPTCHA 或不支持的页面继续交用户接管。

对话元数据、审计、SSE 仅记条目 ID、目标 origin、操作者、动作、结果与时间，不记秘密、完整 URL query 或整页表单。设置管理允许编辑标签、替换值、删除、禁用；不需要做一个完整密码管理器。

## 数据与代码落点（拟议，尚不存在）

- `src/pi/vault.ts`：VaultStore、最小条目结构、元数据视图、版本和增改删。独立存放于 `<dataDir>.vault/`，独立版本 AAD 与密钥，避免扩大 Provider 泄漏范围。只在确有重复时提取很小的私密文件/加密 helper，不重构全部凭据系统。
- `src/pi/vaultUse.ts`：安全请求、授权状态、取消/过期/一次性消费、审计和结果；借用 channelSetup 的模式但补足 run/item/page 绑定。状态机为 requested → approved → executing → succeeded/failed/unknown；超时不自动重试。
- `src/pi/piHost.ts` / `piClient.ts`：管理列表、保存/删除、用户答复端点；清单只返经过裁剪的元数据，秘密字段只写。响应 `no-store`，错误不用第三方原文，凭据不进通用 request-body 日志。云端复用现有身份鉴权和 CSRF 边界，再补 Vault 的用户授权验证。
- `src/pi/browser/`：增加不对 Agent 暴露的 secure-fill IPC 操作。通用 `BrowserRequest.type`/`HostToolResult` 不承载秘密；worker 的内部 payload 也不写日志或错误。实际 origin 必须由 worker 读取，模型 URL 只作意图。
- `src/runtime/`：最小 `useVault` 与安全请求 hook；SettingsDialog 和 approval 接可选 props，OutputFrame 继续负责浏览器。
- privatePaths、附件/产物/工作区 API、childEnv、部署 UID/防火墙、备份脚本：统一覆盖新的目录和密钥。不能只在设置 API 隐藏密码，其他文件入口仍可导出它。

MVP item：`id, version, type=login, label, allowedOrigins, enabled, createdAt, updatedAt`；用户名和密码放加密 payload。用户界面可有脱敏账号提示，Agent 默认只知道用户选择的条目 ID/别名。来源域名是精确 `scheme+host+port`，不沿用 `browserAccountScope()` 的 Google/YouTube 等关联域规则，不用子串、通配域或模型自报可信网站。跨域 SSO 需明确配置登录 origin。

首版仅顶层登录页：当前 worker 明确不支持 frame refs，不能把父页面批准推广到第三方 iframe。后续卡填充需同时绑定顶层商户、frame origin、文档与字段；证据不足就拒绝自动填充。

## 信用卡、联系人和 API key 怎么安排

| 类型 | 建议 |
| --- | --- |
| 登录密码 | 首版；精确站点绑定、每次填充授权、不读回密码。先保留登录后持久 profile，减少重复填充 |
| 联系资料 | 第二步；姓名/地址/电话也加密，可由 host 填充；如需让模型阅读，作为单独授权能力，不默认全量注入记忆 |
| 信用卡 | 后续独立阶段；优先已有支付钱包/外部密码库受控填充或商户已保存的支付方式。自存 PAN 必须先完成支付 iframe、备份与授权验证；不把外部库返回明文给 Agent 当成安全集成 |
| CVV/验证码 | 本方案不长期保存，需用时由用户输入，短暂使用后释放引用；JS 字符串/GC 无法承诺可证明的内存清零。不能仅因 Grok 帮助页有 CVV 字段就照搬 |
| 通用 API key | 暂不并入第一版；已有 Provider/MCP/IM 各自的配置用途保留。以后按固定 endpoint 在 host 注入或代理请求，不做任意 shell 环境注入 |

PCI SSC 对代用户保存卡验证码的服务提供方有明确限制，并专门区分消费者自用设备的情况；单用户自用和未来云端代管不能混为一谈。原始来源与适用边界见一手来源笔记。这里是工程范围建议，不是本项目已通过合规评估的结论。

## 存储与恢复必须明确

复用 AES-GCM 的认证加密、随机 nonce、原子写、revision、权限和损坏保护模式。默认数据加密并不保护已被攻陷的 host；云端外部主密钥与密文分开保管能改善备份泄漏边界，需验证部署重启/迁移不会换钥。首版不承诺跨实例自动恢复。

普通备份默认排除 Vault；未来显式导出只能是单独加密包，恢复需匹配密钥，不能把主密钥与密文一同塞进普通归档。缺钥、损坏、旧版本要报错并保留原文件。

另有现存边界：当前 [backup_data.py](../scripts/agentsphere/backup_data.py) 会包含 browser profile，Chromium 启动使用 `--password-store=basic`。即使 Vault 文件排除，登录后的 cookie 仍是敏感能力。删除 Vault 条目不等于退出网站，清除浏览器登录态不等于删除 Vault；UI 必须分别说明，备份访问与恢复也要按敏感数据对待。禁止浏览器另存密码/卡片，并检查是否产生副本。

## 实施顺序与验收门槛

1. **记录最小功能规格与安全边界**：把入口、owner、单次授权语义放入路线图；实现时再采纳对应 ADR，不在本次研究里默认改变 ADR-014/040/051。
2. **用虚拟 login 做完整闭环**：管理、安全输入、一次性授权、精确域名、主机填充、取消/失败/重启；成功后才接真实账号。存储和填充一起交付，避免只交付一个加密列表。
3. **目标环境验收**：AgentSphere 实测 host/agent/browser 隔离，验证恢复；本机和 AgentMatrix 各自过同样门槛才能开放对应能力。
4. **扩展类型**：联系人，然后评估外部密码库/支付钱包；PAN/CVV 不放进首版。

最窄的有效测试集：

- 存储：重启、密码前后空格/Unicode 不变、错误密钥/篡改拒绝、符号链接/权限拒绝、revision 冲突、不覆盖损坏数据。
- 凭据使用：在 `request/auto/allow-all` 下均需本次批准；用户拒绝、停止、过期、导航、换条目、旧轮回执、重复确认不再填。网络超时返回 unknown 时不自动重放。
- 页面：匹配域成功；相似域/子域/HTTP/重定向/iframe/目标替换拒绝；填充不触发额外点击；普通 `browser_type` 仍拒绝秘密。
- 泄漏：用唯一虚拟 canary 核对工具参数/结果、SSE、会话存储、日志、CLI 原生历史、报错、快照/正文、持久 profile 和备份；特制页面回显/改字段类型/下载导出测试，无法覆盖的恶意页面情况明确记录。
- 隔离：由 Agent UID 尝试读密钥/密文、连接 host 管理与确认端点、worker IPC、CDP；必须拒绝。由用户授权通道完成同一动作必须成功。
- UI：现有 devtools 场景加 Vault 安全输入/授权/失败 fixture，验证关闭清空草稿、不会写 localStorage/sessionStorage、刷新不重发。三引擎和本机 DSH 分别验证 HostTools 可达性，不把通道存在当端到端已验。

运行时代码实施后按项目规范执行 build、相关测试、跨模块全量测试、check:local 和变更涉及的云入口检查；视觉与目标部署验收单列证据。

本次仅核对代码与官方资料、写方案及来源笔记；没有运行产品安全渗透测试、真实登录、付款、构建或部署，不能视为上述验收已通过。
