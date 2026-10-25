# 登录安全输入卡验收（2026-10-25）

用户批准 [方案](../../docs/vault-secure-input-proposal-2026-10-25.md)，要求弹出 UI 与整体一致。实现沿用 `InlineApprovalPrompt` 的审批卡容器、按钮、色彩/字号/圆角，增加独立双字段和可选保存；没有新模态框、组件体系、依赖或服务。决定见 ADR-053。

## 已验证

- `npm test`：503/503，通过，无跳过。`npm run build`、`npm run check:local`、`node scripts/cloud-preview.mjs --check` 通过。构建保留既有大 chunk 警告，无编译错误。
- 主机与真实 Chromium HTTPS：saved/new-no-save/new-save × request/auto/allow-all；保存后重启恢复；跨 Origin/缺 Origin/错误会话/run 拒绝；重复及并发提交仅填一次；未选择保存不写 Vault。
- 存储/页面边界：保存前验证原捕获 DOM 节点，不重新捕获来绕过节点替换；导航、接管、停止、超时、条目变更拒绝；保存失败可重试，落盘不确定则终止；已保存后填充中断回报 saved + unknown，晚到完成不改变回执。表单不提交。
- UI 草稿：两个字段分别受控，掩码，保留空格/Unicode；512/8192 长度；保存默认关闭。重复点击、失败保留输入、切换请求/会话、卸载、取消、过期、迟到 HTTP 响应都有测试。未使用 localStorage/sessionStorage。
- 实际页面：独立本机 5198、受控 bridge 发起真实 HostTools、临时 HTTPS 网站、虚拟凭据。用户通过实际卡片完成不保存填充（Vault revision=0），再勾选保存填充（revision=1），网页收到 4 次字段 input，submit=0。最终版本再次保存，卡片关闭后聊天保留「已保存到 Vault。已填充……」回执。
- 已保存账号 / 使用其他账号切换，亮色、暗色与窄聊天分栏实看。输入框沿用全局主题，按实际可用宽度重排，卡片有高度上限可滚动。保存与取消继续使用既有操作区。
- review 发现 SSE 完成先于 HTTP 回答导致结果卡消失，已修正为主机固定文案的持久聊天回执；有真实 adapter 回归覆盖，特别验证「已保存，未确认填充」不会因关闭卡片丢失。
- devtools 初始页面与 19 个命名内置场景逐项打开，涵盖思考、审批、错误、重试/耗尽/终态、打断和产物；无 console error。该走查验证加载与展示，不代表各场景的每个按钮都完成交互测试。[记录](fixtures.json)
- 分栏实测聊天区域约 520px 时原容器查询仍按全应用宽度计算，改为字段网格按自身宽度自动重排；单列与操作区可用，补改 CSS 后构建通过。[分栏截图](input-split.png)

证据：[亮色输入卡](input-desktop.png)、[暗色输入卡](input-dark.png)、[成功回执](receipt.png)。变化范围的 diff 空白检查及文档链接检查通过；未触碰已有 avatar-eye-study 改动。

## 代码入口

- 主机：[vaultRequests.ts](../../src/pi/vaultRequests.ts)、[vaultUse.ts](../../src/pi/vaultUse.ts)、[piHost.ts](../../src/pi/piHost.ts)。独立 `POST /__agentcanvas/pi/vault/requests/:requestId/answer` 带 conversationId/runId/answer；工具只接受浏览器引用。
- 界面：[useVaultRequest.ts](../../src/runtime/useVaultRequest.ts)、[vaultRequest.ts](../../src/runtime/vaultRequest.ts)、[approval.tsx](../../src/components/agent-preview/chatframe/approval.tsx)。状态走既有 run.awaiting_input 与 inputRequestId；秘密直接 POST 主机。
- 指引：[productFaq.ts](../../src/pi/productFaq.ts)、[browserTools.ts](../../src/pi/browser/browserTools.ts) 与工具 description 一致说明有账号可选、没账号就地输入、取消即停止，不让 Agent 索要聊天里的秘密。

## 边界

测试只使用虚拟账号、受控 bridge、真实浏览器和临时站点，未调用真实外部模型验证自主工具选择，也未登录真实服务。表单确认只授权填充，不授权提交网站；实际目标网站仍能读取填入值。手机真实设备/虚拟键盘、云端隔离、暂停恢复和独立秘密备份恢复未验。既有同 UID 本机限制不变，未部署或推送。

UI 测试脚本与临时数据置于被 git 忽略的 `.local/vault-test/`，独立于默认用户数据；临时 HTTPS 证书只通过测试专用精确 SPKI pin 信任，无生产证书绕过开关。
