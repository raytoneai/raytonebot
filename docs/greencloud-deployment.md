# Greencloud VPS 试用部署（2026-11-01）

本次是单用户试用实例，不复用 AgentSphere 或 AgentMatrix 的部署状态。2026-11-01 在 `b4a22ab` 基础上部署本机工作树的 DSH 与发布、隔离加固；Cloudflare Worker 源码在 `scripts/cloudflare/vps-worker.mjs`。未迁移既有会话、工作区或模型密钥。

2026-11-02 Observer 改动仅在本机实现，尚未发布到此 VPS。更新包必须包含匹配的 `OBSERVER-BUILD.json`、源码、文档及 dist；`apply_release.py` 已允许这些包内项目。新版本私有接口需经既有 Access/Basic 入口交换控制会话，开发者权限另行授予。L2 在云环境保持关闭，现有隔离标志不替代新版本实测。备份恢复的 Observer 私有状态、删除标记、0700/0600 和后台关闭规则见 [迁移说明](product/06-deployment-runbook.md#observer-与控制面迁移2026-11-02本机实现)。本段不改变下文旧部署快照或宣称 VPS 已完成 [OB-09](product/08-acceptance.md#obs-09)。

## 2026-11-03 浏览器启动修复

- Chromium 已安装；实际启动却因 Ubuntu AppArmor 的 `unprivileged_userns` 限制退出，空白临时 profile 同样报 `No usable sandbox!`，内核日志有对应 capability 拒绝。版本检查成功不能证明浏览器能够启动。
- 在 `/etc/apparmor.d/raytonebot-chromium` 为当前 `/opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell` 添加精确路径的 `flags=(unconfined)` / `userns,` profile，按 [Chromium 官方定向配置说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) 加载。全局 `kernel.apparmor_restrict_unprivileged_userns=1` 保持；没有使用 `--no-sandbox`。可执行文件及其所有父目录经检查均为 root 所有、非其他账号可写且无符号链接。
- `scripts/vps/apply_release.py` 现在在确认 Playwright 匹配版本后配置该 profile；版本升级时同步精确路径，不放行通配目录。先校验语法再原子替换，加载失败恢复原 profile；不启用该限制的主机跳过。现有实例可将此脚本复制到 root 私有目录后执行 `python3 -I /root/apply_release.py --browser-apparmor /opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`，实际 revision 应与当前应用匹配。
- 本次仅应用主机 profile，未重新发布应用或重启三个服务；它们保持 active。原启动探针由 409 变为 200，GitHub 登录页导航、1280×800 SSE JPEG 实际画面及远程鼠标移动通过；已检查截图。浏览器独立 UID、no-new-privs、renderer seccomp 与 user namespace 及原双栈防火墙检查通过，四个私密文件哈希不变，未清理 profile 或登录数据。VPS 脚本 12 项测试通过；未验证真实账号登录和整机重启。

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

## 2026-11-08 安装器残留清理修复发布

- `f49675d`、`fc34110` 已随当前 `main` 推送到 `origin/main`。本次仅将两项修复部署至 `/usr/local/sbin/raytonebot-install-engine`；应用包仍保持原 `3494456`、`dirty=true` 清单，未重新发布前端或其他应用代码。
- 线上 helper 的原哈希与修复前源码一致；固定安装计划也一致。持有安装锁后备份旧文件并原子替换，root 所有及 `0755` 权限保持；更新后以应用账号读取固定安装计划成功。
- VPS 上以应用账号运行安装器 11 项隔离回归通过（模拟进程／权限、临时目录）；三个服务保持 active 且 PID 未变，健康检查 activeRuns/activeInstalls 均为 0。4 个私密文件、安装计划、sudoers、应用清单及三种 CLI 入口未变；没有重装 CLI、调用模型或清理成功备份／旧版本。
- 新 helper SHA-256：`bf27613147e7ed42a10fa8ded13e5e432b0084e76ac7267eacb17b1e6831994b`；旧 helper：`4871d67bc69ad9b13e9bfcc951e36948a6ec42b2bb84cc84314e1c8e6a2d0337`。
- 旧文件及远端验证记录保存在 root 私有目录 `/root/raytone-installer-fc34110-GqvYVNT4/`，回退源为 `previous-engine-installer.py`。需要回退时先确认无运行／安装任务并持有原安装锁，再以 root 原子恢复 helper 并复查权限、安装计划读取与健康；未在线上故意触发故障或演练回退。
