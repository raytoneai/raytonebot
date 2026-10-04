# 06 AgentSphere 部署运维手册

平台：AgentSphere 生产栈（E2B fork，Firecracker microVM，单台 OVH 裸金属，无故障自愈）。原始使用指南：本机 `~/Desktop/agentsphere-sandbox-quickstart.md`。首次部署记录：[../agentsphere-deployment.md](../agentsphere-deployment.md)。

## 必须记住的平台事实

| 事实 | 后果 |
| --- | --- |
| **只能用 E2B SDK 1.x**（实测 Python `e2b==1.11.1`；Node `e2b@^1`）；2.x 报 `404: method not allowed` | 部署脚本锁定 1.x |
| 必须设 `E2B_DOMAIN=agentsphere.run`，否则 SDK 连官方 e2b.dev | 脚本启动时断言 |
| 不能用 e2b CLI 登录 | 只用 SDK 脚本 |
| 到 timeout 时：自动暂停实例被暂停，普通实例被回收；`set_timeout(n)` 从调用时起算，单次上限 50 h | 用 `sandbox.py create` 建自动暂停实例 |
| 单机、`SANDBOX_RECOVERY_ENABLED=false` | 沙箱随时可能消失；数据必须定期拉回本机 |
| 公网端口地址 `https://<port>-<sandboxId>.agentsphere.run` | 应用 `RAYTONEBOT_PUBLIC_ORIGIN` 与之一致 |
| 模板 `agentmatrix-v1`：2C/4G、Linux x86_64、Node 24 | 无需在沙箱装 Node |

## 凭据放哪里

| 凭据 | 位置 | 禁止 |
| --- | --- | --- |
| `E2B_API_KEY`（团队 key，可创建任意沙箱） | 本机 shell 环境，或受信任的沙箱外登录服务私有环境 | 写进仓库、沙箱、前端、文档 |
| 访问密码（Basic Auth，用户名 `raytonebot`） | 本机 `.agentsphere/access.json`；沙箱内 600 权限 env 文件 | 写进仓库或文档 |
| 模型 API key | 沙箱 `~/.raytonebot/env`（M1 起）；或浏览器设置面板（仅内存） | 写进 `exported-project.ts` 或 bundle |

`.gitignore` 已排除 `.agentsphere/`、`.env*`、`backups/`。

## 当前实例

- `id705on7k0a1ya1d90icj`（自动暂停），URL：<https://5188-id705on7k0a1ya1d90icj.agentsphere.run>
- 状态文件：`.agentsphere/deployment.json`（sandboxId、到期时间、PID；新部署记录 supervisorPid），`.agentsphere/verification.json`（最近检查结果）。以状态文件为准，本节可能滞后。
- 旧实例 `i7ngpr2af8dxd2ttcy842` 不会暂停，2026-10-04 13:19（北京时间）到期后销毁。

## 持久化（2026-10-03 实测）

| 选项 | 结果 |
| --- | --- |
| 超时自动暂停：创建时传 `{"autoPause": true, "autoResume": {"enabled": true}}` | ✅ 生命周期变为 `onTimeout: pause`；**只能在创建时设置**，已有沙箱无法修改（PATCH/PUT 均 404） |
| 暂停 `POST /sandboxes/{id}/pause` / 恢复 `POST /sandboxes/{id}/resume` | ✅ 整机内存快照：进程 PID、tmpfs、文件、端口都保留，恢复约 1.2 s，URL 不变 |
| 访问 URL 自动唤醒 | ❌ 暂停时公网 URL 返回 502，SDK `connect` 也失败；需调用 resume |
| 单次 timeout 上限 | 50 小时（`Timeout cannot be greater than 50 hours`） |
| 暂停后保留期限 | 未知（平台未说明；单机、无故障自愈），所以仍需定期 `backup` |

应用层：对话（`~/.raytonebot/data/conversations/*.json`）、Pi 模型上下文（`data/pi-sessions/<对话>/`）、Claude/Codex 会话 id 都落盘，重启或重新部署后侧栏、记录和上下文都恢复（本机与云端均验证）。

```bash
S="~/.venvs/agentsphere/bin/python scripts/agentsphere/sandbox.py"
$S create            # 新建自动暂停沙箱（50 h），之后运行 deploy.py
$S status | wake | pause | renew [秒]
$S backup            # 对话 + 三引擎会话 + 工作区 → backups/<id>-<时间>.tgz（不含 env 密钥；在没有运行中的任务时执行）
$S status --logs 30  # 平台状态、认证后的应用 health、最近运行/守护元数据日志
$S backup --scheduled # 外部定时器入口：暂停/运行中/重复触发时跳过，不自动唤醒
$S restore FILE      # 推回沙箱后运行 deploy.py --skip-build
```

备份应在任务空闲时执行：严格读取、tar 失败及 gzip 校验会阻止损坏包被当作成功，但这不是跨文件事务快照。`data` 与 `workspace` 必须存在；CLI 原生目录可缺省，覆盖旧 `/home/user` 及隔离后的 `/home/raytone-agent` 下 `.claude/projects`、`.claude/tasks`、`.codex/sessions`。Claude task id 对应的任务文件必须与 session 一起迁移；只恢复产品计划快照不能恢复原生任务状态。包不包含 env、CLI 登录凭据或整个 home。自定义 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 需另行迁移。

恢复后被替换的数据保留在 `/home/user/.rtb-restore-previous`（root 所有、0700，Agent 不可读；取回需 `sudo`），下一次恢复时覆盖。恢复先验证路径、链接与归档完整性并暂存，再停止 supervisor、cloud-preview 及其子进程，替换包内目录；替换失败回滚。独立 Claude/Codex 进程存在时拒绝恢复，需先停止。备份 worker 使用远端 `sudo -n` 读取不同 UID 的会话并停止写入进程，恢复按目录重设 bot/Agent 的 owner 和工作区共享 group。新实例恢复隔离后的包前，先部署以建立 Agent 系统用户。旧包不含 CLI 目录时保留目标中的这些目录；新旧原生会话目录都有非空内容时迁移拒绝覆盖，需人工决定保留哪份。需要远端 Python 支持 `tarfile.data_filter`（模板已实测支持）。新实例仍须单独配置模型 key/访问密码。2026-10-04 已把独立 UID 版 source 备份恢复到另一个测试实例，验证原生 session IDs、输出文件、bot/Agent 目录 owner 一致，三个引擎在新进程无工具续接旧口令全部通过；操作前两个实例的原始备份均已保留，生产实例未覆盖。

## 部署（2026-10-03 起用脚本）

```bash
export E2B_DOMAIN=agentsphere.run E2B_API_KEY=...      # 只在本机
export DEEPSEEK_API_KEY=...                            # 可选，写入沙箱 env 文件
~/.venvs/agentsphere/bin/python scripts/agentsphere/deploy.py [--sandbox ID] [--timeout 86400] [--skip-build]
```

隔离验收使用 `--sandbox <测试实例> --state-dir <独立目录>`；目录内放测试访问密码，部署结果也只写该目录，避免改动生产 `.agentsphere/deployment.json`。

脚本：本机构建 → 上传（不含 `node_modules`、`.agentsphere`、`.env*`）→ 停止旧 supervisor 与完整进程树 → 替换应用、锁文件变化时才 `npm ci` → 写 `~/.raytonebot/env`（600）并验证 Linux 隔离配置 → `setsid nohup` 启动 supervisor → 从公网 URL 自检（鉴权 401、外站 403、`/health`、`/state`、沙箱模式、工作区布局）→ 更新 `.agentsphere/deployment.json` 与 `verification.json`。隔离后的应用由 root 保护，部署先临时转回 bot 属主安装，完成后重新保护；任何 setup 失败都不启动应用。

沙箱目录：

```
/home/user/raytonebot/            应用（部署覆盖，受保护）
/home/user/.raytonebot/env        bot 凭据配置（受保护）
/home/user/.raytonebot/data/      对话、Pi 会话、设置与归档（受保护）
/home/user/.raytonebot/logs/     runtime.jsonl 与 supervisor.jsonl（元数据日志）
/home/user/workspace/agents/{assistant,planner,builder}/   各角色工作目录
/home/user/workspace/shared/      所有 Agent 共享的协作目录
/home/raytone-agent/              非特权 Agent HOME 与原生 CLI 会话
```

`agentmatrix-v1` 模板已自带 Claude Code（2.1.267）与 Codex CLI（0.154.0）。隔离后的云端 CLI 只使用模型服务与临时 token，不支持 CLI 本机登录；DeepSeek key 保留在 bot 进程，由网关代理请求。本机 macOS 开发仍可选择本机 CLI 登录。部署仅在缺少时安装原生 `ripgrep`、`fd-find`、`acl`，避免 Agent 从受限网络自行下载工具。模板的 fd 8.3.1 缺少 Pi 需要的 `--no-require-git`；能力检查未通过时，部署使用官方 [fd 10.3.0](https://github.com/sharkdp/fd/releases/tag/v10.3.0) 并核对固定 SHA-256，下载或校验失败即终止。Agent 的网络白名单不因此扩宽。

## 日常操作（手工版）

本机准备一次：

```bash
python3 -m venv ~/.venvs/agentsphere && ~/.venvs/agentsphere/bin/pip install 'e2b<2'
export E2B_DOMAIN=agentsphere.run
export E2B_API_KEY=...        # 从 quickstart 取，不要写入任何仓库文件
```

查看 / 续期 / 销毁：

```python
from e2b import Sandbox
sb = Sandbox.connect("<sandboxId>")
print(sb.get_info().end_at)
sb.set_timeout(3600)          # 从现在起约 1 小时
# sb.kill()                   # 销毁，未拉回的文件全部丢失 —— 先问人、先备份
```

## 脚本一览

放在 `scripts/agentsphere/`，Python + `e2b<2`，全部从环境变量读凭据，状态写 `.agentsphere/deployment.json`。

| 命令 | 状态 | 行为 |
| --- | --- | --- |
| `deploy.py [--sandbox ID] [--state-dir 目录] [--timeout 秒] [--skip-build]` | 已实现 | 见上文“部署” |
| `sandbox.py create` | 已实现 | 新建自动暂停沙箱（默认 50 h） |
| `sandbox.py status [--logs 1..200]` | 已实现 | 平台状态、到期时间、认证后的 `/health`；可读最近 supervisor/runtime 元数据日志，暂停实例不连接也不唤醒 |
| `sandbox.py wake` / `pause` / `renew [秒]` | 已实现 | 恢复 / 暂停 / `set_timeout` |
| `sandbox.py backup [--scheduled]` | 已实现 | 对话、工作区、旧/新 Agent HOME 的原生会话拉回 `backups/<id>-<时间>.tgz`；定时模式加互斥锁并跳过暂停或忙碌实例，health 不可用时非零退出 |
| `sandbox.py restore <文件>` | 已实现 | 验证并暂存后停止旧进程、替换数据，失败回滚，之后运行 `deploy.py --skip-build` |
| `kill` | 未实现 | 先自动 `backup`，再销毁，需 `--yes` |

自检必须覆盖 [08](08-acceptance.md) 的 C 组：未登录 401、错误密码 401、跨站 403、登录后页面与资源 200、Pi state 200 且 7 个工具、空 prompt 400。

## 部署注意事项（来自实测）

- 后台用 `setsid nohup python3 scripts/supervisor.py` 脱离 SDK 命令会话，记录 supervisor PID；不要另起不受守护的 preview。停止/部署/恢复用归档 worker 的固定进程树检查，同时停 supervisor，避免旧进程又被自动拉起。
- Vite 的 Host 检查早于插件路由，云域名必须写进 `preview.allowedHosts`（`cloud-preview.mjs` 已处理）。
- 远程 `pkill -f`/`pgrep -f` 的模式会匹配执行它的 shell 自身，要写成 `[c]loud-preview` 形式。
- e2b SDK 在命令非零退出时直接抛异常，脚本需捕获后再判断。
- 沙箱 `/tmp` 里旧文件属主可能不同，上传包放到 `/home/user` 下并每次换名。
- 云入口代理会断开长时间无输出的响应；服务端在运行期间每 5 秒写一个空行心跳。
- 云入口要求 `RAYTONEBOT_PUBLIC_ORIGIN`（裸 HTTPS origin）和 `RAYTONEBOT_PASSWORD`（≥24 字符）；缺任一拒绝启动。
- Codex 内置浏览器与受控 Chrome 访问该域名曾报 `ERR_BLOCKED_BY_CLIENT`；视觉验收改用本机普通浏览器手动打开。不要为绕过它关闭鉴权。

## 续期策略（已定：自动暂停 + 按需唤醒）

沙箱每次运行最多 50 小时，到期自动暂停而不销毁；打开前若 URL 返回 502，先执行 `sandbox.py wake`。长任务前可 `renew`。2026-10-04 已确定由外部负责注册/登录的 bot web server 承担唤醒入口；它在认证后调用现有 `sandbox.py wake`。本项目不新增账号服务，也不在用户电脑启用 launchd/cron。沙箱外方案见根目录 `issue.md` #1。

早期备选（已不采用，保留作参考）：

1. **按需重建**：用时 `deploy --new`，用完 `backup` + `kill`。最省钱，每次约几分钟启动。
2. **本机定时续期**：本机 cron/launchd 每 30–50 分钟 `renew`。电脑关机后实例会过期——与“电脑关机仍在”的目标冲突。
3. **长 timeout**：平台接受 `set_timeout(86400)`（24 小时，2026-10-03 实测）；更长的上限未验证。部署时直接设长并定期 `backup`。

关掉浏览器后任务在云端继续跑（2026-10-03 起）；但沙箱暂停期间 Agent 不运行，单次运行窗口最长 50 小时，长任务前先 `renew`。

## 守护、日志与外部备份定时器

`scripts/supervisor.py` 仅用 Python 标准库：Node 意外退出后 1 秒重启，5 分钟内最多重启 3 次，超限退出并记 `restart_limit`，等排查后重新部署。正常停止不重启。Linux child-subreaper 在 Node 崩溃时收回并停止遗留的独立 CLI 进程组，避免新旧任务同时写文件；清理失败就停止重启。守护进程本身故障或沙箱暂停不会由它自愈，外部 `status`/health 负责发现。

`supervisor.jsonl` 仅记启动、退出、重试、清理结果与 PID/退出码，2 MiB 后保留一份轮转日志。子进程原始 stdout/stderr 不落盘；`runtime.jsonl` 由应用记录脱敏运行元数据，不写 prompt、工具参数、模型 key 或访问密码。需要启动期栈信息时，在受信任终端前台运行现有 cloud-preview；不要把整个进程环境或模型响应复制到日志。

外部 web server 的已有定时器可定时调用下面命令；当前只提供入口，**未注册或启用任何系统定时器**。运行身份需拥有项目状态 `.agentsphere/deployment.json`、访问密码、外部环境中的 E2B key，以及已有 `e2b<2` Python 环境。

```bash
/path/to/python /path/to/RaytoneBot/scripts/agentsphere/sandbox.py backup --scheduled
```

外部定时器自行注入环境变量并收集 JSON 结果。命令不唤醒暂停实例、不续期、不删除旧包；忙碌时等待下次调度，health 不可达或备份损坏时非零退出供外部告警。若需要跨文件强一致快照，再增加维护锁。备份归档可能包含用户敏感文件，应限制外部存储访问；E2B key 始终不进入沙箱。

外部 web server 完成用户认证后调用 `sandbox.py wake`，再自行等待 `/health` 恢复后转入 bot。外部任务调度入口（`external_jobs.py`，提交 `96cc8cd`）已于 2026-10-04 移出主线：在外部服务实际接入前不保留无调用方的调度代码，接入时从该提交取回并按其持久任务存储重做（ADR-016）。
