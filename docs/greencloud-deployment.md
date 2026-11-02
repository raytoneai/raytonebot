# Greencloud VPS 试用部署（2026-11-01）

本次是单用户试用实例，不复用 AgentSphere 或 AgentMatrix 的部署状态。2026-11-01 在 `b4a22ab` 基础上部署本机工作树的 DSH 与发布、隔离加固；Cloudflare Worker 源码在 `scripts/cloudflare/vps-worker.mjs`。未迁移既有会话、工作区或模型密钥。

2026-11-02 Observer 改动仅在本机实现，尚未发布到此 VPS。更新包必须包含匹配的 `OBSERVER-BUILD.json`、源码、文档及 dist；`apply_release.py` 已允许这些包内项目。新版本私有接口需经既有 Access/Basic 入口交换控制会话，开发者权限另行授予。L2 在云环境保持关闭，现有隔离标志不替代新版本实测。备份恢复的 Observer 私有状态、删除标记、0700/0600 和后台关闭规则见 [迁移说明](product/06-deployment-runbook.md#observer-与控制面迁移2026-11-02本机实现)。本段不改变下文旧部署快照或宣称 VPS 已完成 [OB-09](product/08-acceptance.md#obs-09)。

## 入口与边界

Observer L2 由主机执行 `!sandboxed && !process.env.RAYTONEBOT_PUBLIC_ORIGIN` 检查。本 VPS 配置的 `RAYTONEBOT_PUBLIC_ORIGIN` 非空，所以 L2 自动禁用，即使 `RAYTONEBOT_SANDBOX=0` 或已授予 developer 权限也是如此；应保留云入口所需的公开地址配置。具体条件与后续开放要求见 [迁移说明](product/06-deployment-runbook.md#observer-与控制面迁移2026-11-02本机实现)。

`https://BOT_HOSTNAME/` → Cloudflare Access 邮箱一次性验证码 → Worker → Workers VPC Service → Cloudflare Tunnel → VPS 的 `127.0.0.1:5188`。Access 按账户邮箱限制；Worker 核对 Access 身份后，以单独的内部密码访问原有 Basic Auth 入口，并重写受信任的代理 Host。只有通过身份验证的首页顶层 GET 导航可消除 Cloudflare 登录跳转带来的跨站导航标记；接口的 Origin / Fetch-Site 检查保留。Worker 禁用预览 URL。

更新 Worker 前，在 Cloudflare 配置 `PUBLIC_ORIGIN=https://BOT_HOSTNAME`、`ACCESS_AUD` 和 `ACCESS_EMAIL`；缺失或无效时 Worker 返回 403。`ORIGIN_PASSWORD` 是 Cloudflare secret；相同密码保存在 VPS 的 `/home/user/.raytonebot/env`，不要写入仓库或终端记录。Tunnel 使用 `/etc/raytonebot-cloudflared/token`，root 所有、0600。Worker VPC 测试期内免费，正式价格可能改变；Cloudflare 是入口的信任与可用性依赖。

应用以 `user` 运行，执行工具和浏览器分别使用 `raytone-agent` 和 `raytone-browser`。`raytonebot-isolation.service` 启动前执行仓库中的 `setup_isolation.py`，配置文件权限、双栈 nft 和系统 DNS broker ACL；`raytonebot.service` 依赖此服务并运行 supervisor。Tunnel 由 `raytonebot-cloudflared.service` 运行。应用目录 `/home/user/raytonebot` 是 root 所有，工作区 `/home/user/workspace` 与数据目录 `/home/user/.raytonebot/data` 独立。

## 验证与限制

- 本机入口仅监听 `127.0.0.1:5188`；未认证健康检查 401，内部认证后 200。Agent UID 无法读取 env 和 Tunnel token，无法直接连接应用端口；已在当前启动状态检查，未做重启整机演练。
- 浏览器使用 Access 登录后可打开应用；用户随后配置模型，真实 Pi 轮次已验证 `date -u` 与 `web_search` 均成功，测试会话已删除。Claude/Codex CLI 和 Chromium 已验证版本与受限用户可执行，尚未验证这两个引擎的完整真实模型轮次、浏览器任务或完整恢复。
- Tavily 搜索凭据经用户授权从原 AgentSphere 私有环境迁移至 VPS 的 bot 私有 env，已重启应用并验证搜索。首次部署时工作区目录由应用在严格 umask 下创建，Agent 无法进入；现有目录已修复。新的隔离初始化先以应用账号生成完整工作区，再设置组权限；已在 VPS 独立临时目录、`umask 077` 和实际 Agent UID 下验证各角色及 shared 可写，上线后重新检查现有目录可写。尚未通过整机重启验证首次启动流程。
- 项目的 sandbox 模式默认权限为「替我批准」，并非「请求权限」；可在输入框的审批权限中切换。网络规则不是防数据泄露系统，不提供逐 Bot 隔离。
- 登录 Vault 的真实云端凭据使用尚未验收。VPS 数据尚无独立自动备份；普通数据备份不含 Provider/Vault 私密目录和密钥。

## 运维检查

使用已有 SSH 密钥连接后，可检查 `systemctl status raytonebot raytonebot-isolation raytonebot-cloudflared`、`ss -lnt` 和 `journalctl -u raytonebot`。**现有 VPS** 的更新脚本为 `scripts/vps/apply_release.py`；它要求现有的三个 systemd 服务、Node、Claude、Codex、fd、rg、nft、ACL 和与项目匹配的 Playwright Chromium 已就绪。它不是全新 VM 的自动安装器，也不创建 Cloudflare 资源。

若要在隔离环境继续使用 DSH，部署本次开关变更前须由可信运维在 `/home/user/.raytonebot/env` 设置 `RAYTONEBOT_DSH_ISOLATED=1`；该开关不替代 UID、网络和文件隔离验证。更新脚本保留既有 env，不会自行启用 DSH。本次仅调整仓库，未改动线上配置。

从仓库构建后，在本机生成并上传受限发布包及更新脚本（先在本机设置 `VPS_SSH_KEY` 和 `VPS_IP`；不要发送或粘贴 env 内容）：

```bash
npm run build
umask 077
python3 -c 'import sys; sys.path.insert(0, "scripts/agentsphere"); import deploy; sys.stdout.buffer.write(deploy.package())' > /tmp/raytonebot-vps-release.tgz
scp -i "$VPS_SSH_KEY" /tmp/raytonebot-vps-release.tgz scripts/vps/apply_release.py "root@$VPS_IP:/root/"
ssh -i "$VPS_SSH_KEY" "root@$VPS_IP" 'python3 -I /root/apply_release.py /root/raytonebot-vps-release.tgz'
```

发布包只包含 Git 已跟踪源码及 `dist/`，并排除常见私钥和环境文件；新文件必须先 `git add` 才会进入包。跟踪中的文件和前端构建产物仍需由发布者检查是否包含硬编码密钥，过滤规则不是秘密扫描器。`npm run am:deploy` 使用相同的跟踪文件原则；`--clean` 只从 HEAD 构建。

更新脚本先准备依赖，在没有正在运行任务时短暂停止 Tunnel、再次检查空闲、停止应用并创建已校验的数据备份，然后替换应用、重新安装隔离并验证健康和角色目录。失败时尝试恢复旧应用和服务；成功后旧应用保留在 `/home/user/.rtb-release-*-previous`，数据备份在 root 私有的 `/root/raytonebot-backups/`。更新不覆盖 `/home/user/.raytonebot/env` 或 Provider/Vault 私密目录；普通数据备份也**不包含**这些私密目录和环境文件，需要另做安全的异地备份。备份没有自动轮换，需监控磁盘。应用和 Cloudflare 配置不等于数据恢复演练。

新隔离脚本会安装 root 所有的固定检查器，供应用通过受限 sudo 校验当前双栈 Agent 和浏览器防火墙规则；规则缺失或与预期不符时，新的隔离操作拒绝启动。已在该 VPS 的 root 私有临时目录验证检查器安装及现有规则，组合更新后以 bot 账号验证检查器成功；规则篡改和失败回滚仅使用自动测试验证，未在线上实际破坏规则或演练回滚。它在操作开始时检查，不能保证启动后规则永不被管理员更改，也不等同于独立虚拟机或逐 Bot 隔离。
