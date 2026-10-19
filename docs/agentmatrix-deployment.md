# AgentMatrix 承载 RaytoneBot：首个可运行部署（RT-01）

日期：2026-10-19。分支：`am-hosting`。范围：把现有 RaytoneBot 运行时放进一个自有 AgentMatrix
Environment，保留 Node HTTP 主机、三引擎和 `dist` 前端，并给出可重复执行的部署、状态和入口命令。

需求与平台评估见 [需求交接稿](agentmatrix-hosting-minimal-requirements-2026-10-19.md) 和
[可行性评估](agentmatrix-platform-research-2026-10-19.md)。本文件只描述已经实现并可在本分支执行的路径，
不把未实现的平台能力写成已完成。

## 结论先说

AgentMatrix v1 的公开合同**没有 exec / 进程 / SSH 接口**：能创建 Environment、绑定 Workspace、
创建 Session 和签发 Preview，但不能直接让平台执行一条命令。因此首期部署用一个**受控的 Session 轮次**
执行仓库里固定的一条命令：

```
bash /workspace/am/bootstrap.sh install
bash /workspace/am/bootstrap.sh start https://<preview-origin>
```

命令、脚本、发布包摘要都由部署脚本提供，模型不选择命令、不生成脚本。这满足“先跑起来”，
但不满足 AM-01 要求的“确定性部署控制面”；后者仍需平台提供受支持的 exec/生命周期入口。

## 一条命令

```bash
export ARIADRA_API_KEY=...          # Console → API Keys，data-plane key
export ARIADRA_NAMESPACE=default    # 可选
export DEEPSEEK_API_KEY=...         # 可选：写进 bot 私有 env，Agent 子进程拿不到
npm run am:plan                     # 只打印解析结果，不创建资源
npm run am:deploy                   # 发布、安装、启动、自检
npm run am:status                   # Environment/Session/Preview/health
npm run am:preview                  # 刷新短期签名入口
npm run am:stop                     # 停应用、归档 Session、删除 Environment（保留 Workspace）
```

`am:deploy` 需要同一 namespace 里有一个可用的 AgentSpec（`claude_code`，`tool_permission_mode`
为 `bypassPermissions`；`codex_cli` 用 `never`），否则会明确报错并提示创建。默认自动发现
`raytonebot-bootstrap` 或唯一的 AgentSpec；也可用 `AGENTMATRIX_AGENT_SPEC_ID` /
`AGENTMATRIX_AGENT_SPEC_VERSION` 固定。LLM credential 省略时由平台默认解析。

可选覆盖：`AGENTMATRIX_WORKSPACE_ID`、`AGENTMATRIX_ENVIRONMENT_SPEC_ID`、
`AGENTMATRIX_SANDBOX_ID`、`AGENTMATRIX_PORT`、`AGENTMATRIX_REGION`、`ARIADRA_BASE_URL`。

## 部署做了什么

1. **固定发布包**：`git` commit（脏树会带 `-dirty`）+ `npm run build` 的 `dist/` + 全部源码与
   `vendor/`，打包成 `raytonebot-<sha8>.tar.gz`，记录 SHA-256 和 SDK/合同版本。压缩后约 8.9 MB，
   低于 20 MiB 附件上限。
2. **Workspace**：按名称复用或创建 `raytonebot` Workspace（一个逻辑部署一个卷）。
3. **EnvironmentSpec**：复用或创建 `raytonebot-e2b`，出站 `deny` + 只放行 `api.deepseek.com`、
   `registry.npmjs.org`，入站只开放 5188 端口给 PreviewProxy。
4. **Environment**：创建或复用独立的 Environment，创建时绑定 Workspace（绑定后不可换）。
5. **发布**：`/v1/workspaces` 文件 API 按 1 MiB 分片写 `/workspace/am/release/part-*`，
   另写 `bootstrap.sh`、`release.sha256`、`secrets.env`（启动后移入私有 env 并删除）。
6. **Session**：在 Environment 上复用空闲 Session 或新建一个，轮次里依次执行 install/start。
7. **Preview**：为 5188 端口签发短期签名 URL；该 URL 的 origin 就是应用的 `RAYTONEBOT_PUBLIC_ORIGIN`。
8. **自检**：`bootstrap.sh start` 在机器内轮询 `GET /__agentcanvas/pi/health`（Basic Auth），
   成功才返回 `AM_LISTENING`；部署脚本再把结果写进 `am/listening.ok` 并探测一次入口 URL。

Sandbox 内布局：

```
/workspace/raytonebot/            应用（发布包解压 + npm ci）
/workspace/.raytonebot/data/      对话、Pi 上下文、记忆、MCP/IM/routine 配置、审批记录
/workspace/.raytonebot/env        私有 env（600）
/workspace/.raytonebot/logs/      install / preview / keepalive 日志
/workspace/am/                    bootstrap、发布分片、release.sha256、状态标记
/workspace/agents/… /shared/      RAYTONEBOT_WORKSPACE_ROOT=/workspace 下的角色目录
```

数据目录和角色根都在 Workspace 上，所以换 Environment、重绑同一 Workspace 后数据仍在；这是 RT-02
的首期形态。模型 key 与访问密码只在 `secrets.env` → 私有 env 的窗口里出现，不进发布包、不进 prompt、
不进 Session 事件。

## 入口与鉴权

`RAYTONEBOT_PUBLIC_ORIGIN` 设为 preview origin，应用原有的 Basic Auth、Host/Origin 与 CSRF 检查全部保留。
`RAYTONEBOT_TRUST_PROXY_ORIGIN=1` 让 Host 校验额外接受 **且仅接受** `x-forwarded-host` 等于配置 origin
的请求，用于 PreviewProxy 转发时改写 Host 的情况；该开关默认关闭，直连实例不得开启。

Preview URL 是短期签名链接（`url_expires_at`），可能带 `/.ariadra/preview/open?token=…` 入口路径，
不是稳定书签入口。`npm run am:preview` 取新链接；链接过期不影响应用进程。

## 已验证 / 未验证

| 项目 | 状态 |
| --- | --- |
| 发布包可重复构建、摘要、< 20 MiB | 已验证（本机） |
| 认证、Host/Origin、CSRF、代理 Host 信任、handoff | `node scripts/cloud-preview.mjs --check` 通过 |
| 适配层单元测试（配置、分片、分页、入口 origin、日志提取） | 通过 |
| 真实 AgentMatrix 租户上的部署 | **待执行**：本机没有 `ARIADRA_API_KEY` |
| Sandbox 内 `npm ci` 与 Chromium 浏览器 | 未验证；模板不含 Chromium，浏览器接管功能可能不可用 |
| 无人访问时 IM / routines 持续运行 | 未验证；Environment 空闲仍会 pause（AM-03） |
| 崩溃后自动恢复、稳定入口、独立备份 | 未实现（AM-01/03/04/05） |
| UID/网络隔离（raytone-agent、raytone-browser、nft、ACL） | 未实现；AM Environment 是单一 OS 账号 |

## 与需求稿的对应

- RT-01：发布包、摘要、启动/停止/health、最小部署适配 —— 本分支。
- RT-02：产品数据与角色目录落在 `/workspace`；Claude/Codex 原生会话仍写在 `$HOME` 下，换机不会带走，
  归档/校验/恢复脚本也尚未接入。
- RT-03：origin 与代理 Host 的适配已做；稳定入口、鉴权 handoff 由平台提供。
- RT-04：功能回归按要求仍需在真实 Environment 上跑三引擎两轮、群聊、审批、MCP、记忆等；
  本分支没有声明这些已通过。

## 不做什么

不把托管 Session 换成 RaytoneBot 的运行时，不接 Event Bus，不做多实例、自动扩缩容、图形化恢复，
也不在没有独立备份的情况下声称整机可恢复。
