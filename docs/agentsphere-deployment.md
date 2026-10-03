# AgentSphere 部署实验

2026-10-03：RaytoneBot + Pi 已部署到 AgentSphere，公网 HTTP 检查通过。沿用现有 AgentCanvas 界面，没有引入 OpenAgentCore。

## 实例与访问

- 地址：<https://5188-i7ngpr2af8dxd2ttcy842.agentsphere.run>
- 沙箱：`i7ngpr2af8dxd2ttcy842`，模板 `agentmatrix-v1`，2 CPU / 4 GB，Linux x86_64，Node.js 24.18.0。
- 登录用户名：`raytonebot`；随机访问密码见本机 [access.txt](../.agentsphere/access.txt)。该文件不进入版本库或部署包。
- 本次最后设置的到期时间：**2026-10-04 13:19:12（北京时间）**（2026-10-03 13:19 用 `set_timeout(86400)` 续期 24 小时）。这是临时实验实例，没有自动续期；到期后 URL 不再可用，不承诺数据保留。
- 最新实例状态保存在本机 [deployment.json](../.agentsphere/deployment.json)，HTTP 验证结果在 [verification.json](../.agentsphere/verification.json)。

依据用户提供的 `/Users/rickyhuo/Desktop/agentsphere-sandbox-quickstart.md`，使用独立临时 Python 环境中的 `e2b==1.11.1` 和 `E2B_DOMAIN=agentsphere.run`。部署凭证仅在本机 SDK 进程内读取，没有复制进沙箱、源码或此笔记。

## 实际部署方式

1. 本机构建 React 产物，上传 `dist`、现有 Pi 运行代码、Vite 配置、vendored SDK、包清单与锁文件；不上传本机 `node_modules`、环境文件或模型凭据。
2. 在沙箱 `/home/user/raytonebot` 运行 `npm ci --no-audit --no-fund`，安装 Linux 依赖。
3. 通过 [cloud-preview.mjs](../scripts/cloud-preview.mjs) 启动现有 Vite preview + Pi plugin，监听 5188。只增加云端入口，没有修改 UI、事件协议或原生 Pi 工具审批。
4. 用 HTTPS Basic Auth 保护页面、静态资源和全部 Pi 请求。入口严格校验实例 Host/Origin；通过鉴权后才将内部请求标准化为 loopback，保持 Pi 原有校验。Vite 只放行该实例域名，关闭额外 CORS。
5. 启动进程使用受控环境和独立 `PI_CODING_AGENT_DIR=/home/user/.raytonebot-pi`；实例访问密码保存在沙箱内权限为 600 的环境文件中。Pi 工作目录是项目目录。

> 2026-10-03 更新：现由 `scripts/agentsphere/deploy.py` 部署，env 文件移至受保护目录 `~/.raytonebot/env`，Agent 工作区为 `/home/user/workspace`。现行步骤见 [06-deployment-runbook.md](product/06-deployment-runbook.md)。

本地默认 `npm run dev` / `npm run preview` 仍监听 127.0.0.1。仅 `npm run preview:cloud` 启用云入口，要求环境变量 `RAYTONEBOT_PUBLIC_ORIGIN`（HTTPS origin）与 `RAYTONEBOT_PASSWORD`（至少 24 字符）。不能省略密码直接公开 Pi。

## 已验证与限制

| 检查 | 结果 |
| --- | --- |
| 本机 `npm run build` | 通过；保留上游 chunk 大小及未来 Vite 配置加载方式提示。 |
| 本机/沙箱 `node scripts/cloud-preview.mjs --check` | 通过：密码、Host/Origin、跨站拒绝与内部标准化。 |
| 公网 HTTPS 页面及入口 JS/CSS | 带正确密码返回 200；HTML 包含 RaytoneBot。 |
| 未登录页面、静态资源、Pi、OPTIONS；错误密码 | 均返回 401。 |
| 同源 Pi `/state` | 返回 200；真实 SDK 已加载，read/bash/edit/write/grep/find/ls 七工具已注册。 |
| 空 prompt | 返回 400；未发送模型请求。 |
| 外站 Origin、cross-site 请求 | 返回 403。 |
| 部署源码一致性 | 云入口与本地文件一致。 |
| 浏览器视觉验收 | 未完成。Codex 内置浏览器和受控 Chrome 报 `ERR_BLOCKED_BY_CLIENT`；未关闭浏览器防护，也未取消服务器鉴权。HTTP 成功不等于已完成浏览器验收。 |
| 真实模型任务、工具执行与流式回复 | 未验证。云端可用模型凭据数量为 0；本机模型凭据未迁移。模型默认配置保持原样。 |

这是单用户临时预览，使用 Vite preview 承载现有 Pi plugin。会话仍在内存中，进程重启或页面刷新不能恢复完整历史；本次没有增加数据库、持久卷、后台任务或多用户权限。

## 生命周期与复现要点

通过 SDK 连接已有沙箱不会重建部署；`set_timeout(3600)` 从调用时延长到约一小时后。停止实验用 `kill()`，会销毁该沙箱及其中未导出的文件。续期或销毁均需在本机安全配置 `E2B_API_KEY` 与 `E2B_DOMAIN`，不要将部署 key 放入应用前端。

```python
from e2b import Sandbox  # e2b==1.11.1

sandbox = Sandbox.connect("i7ngpr2af8dxd2ttcy842")
info = sandbox.get_info()
print(info.end_at)
# 按需执行其中一个：
# sandbox.set_timeout(3600)
# sandbox.kill()
```

启动或重启入口时，后台命令使用 `exec` 保证记录的 PID 就是服务进程；本次曾发现只停止 SDK 外层 shell 会留下旧 Node 监听进程。云入口的域名白名单必须在 Vite 的 `preview.allowedHosts` 中显式设置，因为 Vite 自身的 Host 检查早于插件路由。

## 对先前研究的修正

已有平台现已明确为 AgentSphere 的 E2B fork，指南要求 SDK 1.x；本次 1.11.1 创建、文件上传、命令执行、公网端口和续期均实测成功。OpenAgentCore 研究快照的内置 E2B helper 固定 SDK 2.51.0，**不能把本次成功理解为其内置 Provider 已兼容 AgentSphere**。若以后采用 Core，应优先验证应用管理的 `self_hosted` daemon 路径，详见 [OpenAgentCore 笔记](openagentcore-assessment.md)。
