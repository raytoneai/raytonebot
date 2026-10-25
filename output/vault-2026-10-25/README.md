# 登录 Vault 本机验收（2026-10-25）

用户批准登录凭据 MVP，入口 Settings → Vault，复用现有授权卡与 Output 浏览器。信用卡不在范围内。实现决定见 [ADR-052](../../docs/product/07-decisions.md#adr-052登录-vault-由主机保存与逐次授权填充2026-10-25)。

## 完成行为

- 新增、编辑、停用、删除；用户名/密码输入掩码，只写不回读，编辑留空保留；更换网站须重新输入两者。关闭设置/离开 Vault 清空草稿。API 回传元数据，未使用浏览器存储保存秘密。
- 主机 AES-256-GCM 密文、0700 目录/0600 文件、独立主密钥、revision 冲突、原子提交；损坏不覆盖，链接/所有者不符拒绝。
- `vault_request_use` 只携带当前页面引用；用户从同 HTTPS origin 的条目中选择一次。request/auto/allow-all 都必须答复。条目版本、run/bot/conversation、页面/快照/控制权/原 DOM 节点绑定，过期与停止可撤销。
- 私有 IPC 直接填入，不点击提交、不按 Enter。填后敏感文档的模型快照/正文/标题隐藏，下载阻止；用户可在原浏览器画面中接管并提交。不确定结果不自动重放。

## 验证

- `npm test`：487/487，通过，无跳过。包括 Vault 存储 13 项、授权/主机闭环 3 项，以及真实 Chromium 浏览器回归。后补 host-stop 分支与工具指引后，59 项定向复验有 1 项因旧指引固定措辞失败；保留原警示并补充 Vault 后，相关存储/授权/账号上下文 22 项复验全部通过，构建通过。
- `npm run build`、`npm run check:local`、`node scripts/cloud-preview.mjs --check`：通过。构建保留既有较大 chunk / Vite 配置警告，无编译错误。
- `vaultUse.test.ts`：临时 HTTPS 站点、短期证书的精确 SPKI 测试 pin、真实 Chromium，HTTP 保存 → 主机重启 → 受控 bridge 调用真实 HostTools → 既有提问事件 → `/input` → 实际表单收到虚拟值；逐一验证三种权限模式。外站来源/缺少 Origin/跨会话回答拒绝；重复回答不重复填充；提交次数为 0；事件、历史、接口、磁盘密文不包含虚拟秘密。
- 浏览器边界：过时快照、导航（含尚未提交的导航）、DOM 替换、控制权变化、停止、两字段间撤销、HTTP、新密码框；填后输出与下载保护。生产路径无 HTTP 放行或证书绕过开关。
- 实际设置页：空列表、新增输入掩码、保存、编辑时秘密留空、更改 origin 必须重填、取消、刷新恢复；[截图](settings.png)。保存的仅为 `https://example.com` 虚拟演示条目，不曾向该网站提交凭据。
- devtools：初始欢迎页/Built-in demo 及 [18 个命名场景](fixtures.json) 逐项打开，含思考、审批、错误、重试/耗尽/终态、打断、产物；无浏览器 console error。此为界面加载走查，不是每项交互的完整回归。
- 变更范围 `git diff --check`：通过；未涉及的 `tmp/avatar-eye-study` 原有改动保持不动。

## 本机复现

在仓库根目录运行（这次实际使用了该独立目录，未改默认用户数据）：

```sh
RAYTONEBOT_DATA_DIR="$PWD/.local/vault-test/data" RAYTONEBOT_VAULT_DIR="$PWD/.local/vault-test/Vault" npm run dev -- --host 127.0.0.1 --port 5188
```

打开 http://127.0.0.1:5188/ → Settings → Vault。`.local/vault-test/` 被 git 忽略，Vault 目录中保存 `logins.enc` 与自动生成的 `master.key`；均为虚拟测试资料，不上传。已有进程占用 5188 时先确认其用途，勿直接启动第二实例替换。

重复自动闭环：`node --test src/pi/vault.test.ts src/pi/vaultUse.test.ts src/pi/browser/vaultFill.test.ts`。需已安装项目使用的 Chromium 及本机 openssl；测试自行创建 HTTPS 站点和临时目录并清理，不调用外部模型或账号。

## 尚未验证与限制

只支持顶层 HTTPS 登录框，密码框须明确设置 `autocomplete=current-password`；iframe、验证码、新密码、多步用户名页改走接管。IM/群聊不开放。填入后原网页 JavaScript 本就能读取凭据，因此精确 origin 绑定不能防住恶意目标站点；输出屏蔽也不承诺任意编码/旁路不可泄漏。

本机 Agent 与 host 同 UID，文件权限与 CSRF 请求头不提供对恶意本机进程的硬隔离；整目录含主密钥被复制即可解密。未测试真实模型自主选工具、真实网站账号登录、手机/深色主题、云端 UID/网络隔离、暂停恢复或独立私密备份恢复。默认 Vault 位于普通数据备份之外，必须另外保存匹配密钥与密文。未部署、未推送。
