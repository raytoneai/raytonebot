# 06 AgentSphere 部署运维手册

平台：AgentSphere 生产栈（E2B fork，Firecracker microVM，单台 OVH 裸金属，无故障自愈）。原始使用指南：本机 `~/Desktop/agentsphere-sandbox-quickstart.md`。首次部署记录：[../agentsphere-deployment.md](../agentsphere-deployment.md)。

## 必须记住的平台事实

| 事实 | 后果 |
| --- | --- |
| **只能用 E2B SDK 1.x**（实测 Python `e2b==1.11.1`；Node `e2b@^1`）；2.x 报 `404: method not allowed` | 部署脚本锁定 1.x |
| 必须设 `E2B_DOMAIN=agentsphere.run`，否则 SDK 连官方 e2b.dev | 脚本启动时断言 |
| 不能用 e2b CLI 登录 | 只用 SDK 脚本 |
| 沙箱到 timeout 自动回收；`set_timeout(n)` 从调用时起算 | 需续期或接受重建 |
| 单机、`SANDBOX_RECOVERY_ENABLED=false` | 沙箱随时可能消失；数据必须定期拉回本机 |
| 公网端口地址 `https://<port>-<sandboxId>.agentsphere.run` | 应用 `RAYTONEBOT_PUBLIC_ORIGIN` 与之一致 |
| 模板 `agentmatrix-v1`：2C/4G、Linux x86_64、Node 24 | 无需在沙箱装 Node |

## 凭据放哪里

| 凭据 | 位置 | 禁止 |
| --- | --- | --- |
| `E2B_API_KEY`（团队 key，可创建任意沙箱） | 仅本机 shell 环境 / 本机未入库文件 | 写进仓库、沙箱、前端、文档 |
| 访问密码（Basic Auth，用户名 `raytonebot`） | 本机 `.agentsphere/access.txt`；沙箱内 600 权限 env 文件 | 写进仓库或文档 |
| 模型 API key | 沙箱 `~/.raytonebot/env`（M1 起）；或浏览器设置面板（仅内存） | 写进 `exported-project.ts` 或 bundle |

`.gitignore` 已排除 `.agentsphere/`、`.env*`。

## 当前实例

- URL：<https://5188-i7ngpr2af8dxd2ttcy842.agentsphere.run>
- 状态文件：`.agentsphere/deployment.json`（sandboxId、到期时间、PID），`.agentsphere/verification.json`（最近检查结果）。
- 它是临时实验实例，到期即失效，不承诺保留数据。

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
$S backup            # 对话 + Pi 会话 + 工作区 → backups/<id>-<时间>.tgz（不含 env 密钥）
$S restore FILE      # 推回沙箱后运行 deploy.py --skip-build
```

当前实例：`id705on7k0a1ya1d90icj`（自动暂停），<https://5188-id705on7k0a1ya1d90icj.agentsphere.run>。旧实例 `i7ngpr2af8dxd2ttcy842` 不会暂停，2026-10-04 13:19（北京时间）到期后销毁。

## 部署（2026-10-03 起用脚本）

```bash
export E2B_DOMAIN=agentsphere.run E2B_API_KEY=...      # 只在本机
export DEEPSEEK_API_KEY=...                            # 可选，写入沙箱 env 文件
~/.venvs/agentsphere/bin/python scripts/agentsphere/deploy.py [--sandbox ID] [--timeout 86400] [--skip-build]
```

脚本：本机构建 → 上传（不含 `node_modules`、`.agentsphere`、`.env*`）→ 锁文件变化时才 `npm ci` → 写 `~/.raytonebot/env`（600，位于受保护目录）→ 停掉所有旧进程并用 `exec` 启动 → 从公网 URL 自检（鉴权 401、外站 403、`/state`、沙箱模式、工作区布局）→ 更新 `.agentsphere/deployment.json` 与 `verification.json`。沙箱内 env 包含：`RAYTONEBOT_PUBLIC_ORIGIN`、`RAYTONEBOT_PASSWORD`、`RAYTONEBOT_SANDBOX=1`、`RAYTONEBOT_WORKSPACE_ROOT=/home/user/workspace`、`PI_CODING_AGENT_DIR`、`DEEPSEEK_API_KEY`。

沙箱目录：

```
/home/user/raytonebot/            应用（部署覆盖，受保护）
/home/user/.raytonebot/env|pi/    配置与 Pi 数据（受保护）
/home/user/workspace/agents/{assistant,planner,builder}/   各角色工作目录
/home/user/workspace/shared/      所有 Agent 共享的协作目录
```

`agentmatrix-v1` 模板已自带 Claude Code（2.1.267）与 Codex CLI（0.154.0）。沙箱内不需要登录 Codex：「实施」角色默认用模型服务（DeepSeek 的 Responses API + `DEEPSEEK_API_KEY`）。只有在设置里切到「本机 Codex 登录」时才需要 `codex login`。

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

## 目标脚本（T1.6 / T3.1 实现）

放在 `scripts/agentsphere/`，Python + `e2b<2`，全部从环境变量读凭据，状态写 `.agentsphere/deployment.json`。

| 命令 | 行为 |
| --- | --- |
| `deploy [--new]` | 本机 `npm run build` → 打包 `dist`、`src/pi`、`src/harness`、`vendor`、`scripts`、`vite.config.ts`、`package*.json`（不含 `node_modules`、`.agentsphere`、`.env*`）→ 上传到 `/home/user/raytonebot` → `npm ci --no-audit --no-fund` → 写 env（600）→ 用 `exec` 启动服务 → 等待 health → 运行 HTTP 自检 |
| `status` | 到期时间、进程是否存活、health、最近日志 |
| `renew [秒]` | `set_timeout` 并更新状态文件 |
| `backup` | 打包 `~/.raytonebot/sessions` + `/home/user/workspace` 拉回本机 `backups/<时间>.tar.gz`（`backups/` 入 `.gitignore`） |
| `restore <文件>` | 上传并解包到新实例，重启服务 |
| `kill` | 先自动 `backup`，再销毁，需 `--yes` |

自检必须覆盖 [08](08-acceptance.md) 的 C 组：未登录 401、错误密码 401、跨站 403、登录后页面与资源 200、Pi state 200 且 7 个工具、空 prompt 400。

## 部署注意事项（来自实测）

- 后台启动必须用 `exec node ...`，否则记录的 PID 是外层 shell，停止时会留下旧 Node 监听 5188。
- Vite 的 Host 检查早于插件路由，云域名必须写进 `preview.allowedHosts`（`cloud-preview.mjs` 已处理）。
- 远程 `pkill -f`/`pgrep -f` 的模式会匹配执行它的 shell 自身，要写成 `[c]loud-preview` 形式。
- e2b SDK 在命令非零退出时直接抛异常，脚本需捕获后再判断。
- 沙箱 `/tmp` 里旧文件属主可能不同，上传包放到 `/home/user` 下并每次换名。
- 云入口代理会断开长时间无输出的响应；服务端在运行期间每 5 秒写一个空行心跳。
- 云入口要求 `RAYTONEBOT_PUBLIC_ORIGIN`（裸 HTTPS origin）和 `RAYTONEBOT_PASSWORD`（≥24 字符）；缺任一拒绝启动。
- Codex 内置浏览器与受控 Chrome 访问该域名曾报 `ERR_BLOCKED_BY_CLIENT`；视觉验收改用本机普通浏览器手动打开。不要为绕过它关闭鉴权。

## 续期策略（已定：自动暂停 + 按需唤醒）

沙箱每次运行最多 50 小时，到期自动暂停而不销毁；打开前若 URL 返回 502，先执行 `sandbox.py wake`。长任务前可 `renew`。以下为早期备选，保留作参考：

可选其一，需用户决定：

1. **按需重建**：用时 `deploy --new`，用完 `backup` + `kill`。最省钱，每次约几分钟启动。
2. **本机定时续期**：本机 cron/launchd 每 30–50 分钟 `renew`。电脑关机后实例会过期——与“电脑关机仍在”的目标冲突。
3. **长 timeout**：平台接受 `set_timeout(86400)`（24 小时，2026-10-03 实测）；更长的上限未验证。部署时直接设长并定期 `backup`。

在 pause/resume、持久卷能力验证前，不承诺“电脑关机后任务继续”。
