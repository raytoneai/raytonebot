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
npm run am:plan                     # 只打印解析结果，不创建资源，不构建
npm run am:deploy                   # 发布、安装、启动、自检（用当前工作树构建）
npm run am:deploy -- --clean        # 从 HEAD 的临时 worktree 构建，脏工作树不进入发布包
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
   `vendor/`，打包成 `raytonebot-<sha8>.tar.gz`，记录 SHA-256 和 SDK/合同版本。压缩后约 8.7 MB，
   低于 20 MiB 附件上限。`--clean` 在临时 worktree 里从 HEAD 构建并打包，未提交改动不会进入发布。
2. **Workspace**：按名称复用或创建 `raytonebot` Workspace（一个逻辑部署一个卷）。
3. **EnvironmentSpec**：复用或创建 `raytonebot-e2b`，入站只开放 5188 端口给 PreviewProxy；出站优先
   `deny` + 只放行 `api.deepseek.com`、`registry.npmjs.org`。若所选 provider 的
   `capabilities.network.outbound_allowlist` 为 false（当前租户的 container provider 就是），
   适配层会退化为 `default: allow` 并明确记录，不假装已经限流。
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

`RAYTONEBOT_PUBLIC_ORIGIN` 设为 preview origin。应用原有的 Basic Auth、Host/Origin 与 CSRF 检查保留；
`RAYTONEBOT_TRUST_PROXY_ORIGIN=1` 只让 Host 校验接受代理改写后的 Host（`x-forwarded-host` 或
loopback Host + `x-forwarded-port: 443`）。

因为 PreviewProxy 剥掉所有客户端凭证，`RAYTONEBOT_PREVIEW_INGRESS=1` 额外允许“经代理到达”的请求免
Basic Auth，以签名 URL 作为凭证；直连（无代理标记）仍返回 401。该开关只应在平台入口后面打开。

机器存活期间 `https://prv-….preview.agentmatrix.pro/` 可以直接打开；`/.ariadra/preview/open?token=…`
是带 5 分钟签名的唤醒/进入链接，过期只影响该链接，不影响应用进程。`npm run am:preview` 取新链接，
`npm run am:wake` 恢复暂停的 Environment 并刷新链接。

## 首次真实部署结果（2026-10-19）

在租户 `default` 上完成一次真实部署并验证应用在 AgentMatrix 入口可用：

| 资源 | 值 |
| --- | --- |
| Workspace | `vol_01M59N4B5GVN4HGWHB14NDC7PP`（`raytonebot`） |
| EnvironmentSpec | `env_55a0acd8783b283457a779b5a699cf1d`（`raytonebot-e2b`，container provider） |
| Environment | `sbx_b31c43b7cdcb5d560292f227f4ce12e218b2a7cd16f7e7696720909586a9eb60` |
| Session | `ssn_45d9074cdc4fc41384a6a44fb31ff6bf`（`Ariadra-Starter-Assistant` v1, claude_code / bypassPermissions） |
| Preview | `prv_be9d0d136cd0fa8b3fc1f373d1fdfc5b`，端口 5188 |
| 稳定 origin | `https://prv-be9d0d136cd0fa8b3fc1f373d1fdfc5b.preview.agentmatrix.pro/` |

实测：入口 `GET /` 返回 200 与应用 HTML，`/assets/*` 200，`GET /__agentcanvas/pi/health` 返回
`{"status":"ok",...}`，`/__agentcanvas/pi/state` 与 `/__agentcanvas/pi/conversations` 正常。
Workspace 里产品数据落在 `.raytonebot/data`，角色目录在 `agents/{assistant,planner,builder}` 与 `shared`。

部署中确认的平台事实（都已写进脚本）：

- **PreviewProxy 会剥掉 `Authorization`、`Cookie` 和自定义请求头**，只保留 `host`、`user-agent`、
  `accept(-encoding)`、`x-forwarded-port`。因此浏览器无法携带 Basic Auth 或会话 Cookie 进入应用。
  适配层用 `RAYTONEBOT_PREVIEW_INGRESS=1` 把“经代理转发”当作入口凭证（签名 URL 本身是短期凭证），
  直连请求仍要求 Basic Auth。这是对“保留现有鉴权”的**已知偏离**，正式入口仍应由 AM-04 提供。
- PreviewProxy 会把 `Host` 改写成上游地址并只给 `x-forwarded-port: 443`，所以应用侧用
  `RAYTONEBOT_TRUST_PROXY_ORIGIN=1` 接受这种代理请求。
- 首次 `npm ci` 约 10 分钟（450 包），正好等于一次 turn 的执行预算，所以安装是分离进程 + 标记文件轮询；
  之后只要 lockfile 不变就复用 `node_modules`，部署约 1–2 分钟。
- 空闲约 5 分钟后 Environment 会 pause；进程被冻结而不是被杀，resume 后继续（首次安装跨过一次 pause
  仍完成）。`am:wake` / 新的入口请求可以恢复。
- 租户 provider 是 `container_sandbox`，`outbound_allowlist=false`，所以只能开放出站；这是平台能力缺口，
  不是适配层的选择。

## 已验证 / 未验证

| 项目 | 状态 |
| --- | --- |
| 发布包可重复构建、摘要、< 20 MiB | 已验证（本机） |
| 认证、Host/Origin、CSRF、代理 Host 信任、预览入口、handoff | `node scripts/cloud-preview.mjs --check` 通过 |
| 适配层单元测试（配置、分片、分页、入口 origin、日志提取） | 通过 |
| 真实 AgentMatrix 租户上的部署与应用响应 | 已验证（见上表） |
| Sandbox 内 `npm ci` | 已验证（约 10 分钟；之后复用） |
| Chromium 浏览器、真实模型轮次、IM、routines | 未验证；模板不含 Chromium，租户没有注入模型 key |
| 无人访问时 IM / routines 持续运行 | 未验证；Environment 空闲仍会 pause（AM-03） |
| 崩溃后自动恢复、稳定鉴权入口、独立备份 | 未实现（AM-01/03/04/05） |
| UID/网络隔离（raytone-agent、raytone-browser、nft、ACL） | 未实现；AM Environment 是单一 OS 账号 |

## 浏览器能力缺口（2026-10-19 实测）

截图里 Raer 说“没有 Chromium/Firefox/Playwright”是准确的：`playwright-core` 已在
`node_modules`，但没有浏览器二进制，而且系统库也不全。实测结论：

| 项目 | 实测 |
| --- | --- |
| 身份 | `uid=1000(user)`；`sudo` 存在但被 `no_new_privs` 禁止，无法 apt 安装系统包 |
| 浏览器 | PATH 无 Chromium/Chrome；`/opt/pw-browsers`、`~/.cache/ms-playwright` 不存在 |
| Playwright 期望 | `chromium-headless-shell:1248`（`playwright-core@1.64`） |
| 系统库 | libnss3、libnspr4、libatk-1.0、libatk-bridge-2.0、libcups2、libdrm2、libxkbcommon、libXcomposite、libXdamage、libXfixes、libXrandr、libgbm、libpango、libcairo、libasound 全部缺失 |
| 资源 | `/workspace` 剩 97G；出站可用，下载不是瓶颈 |

后果：浏览器接管/截图/点击等工具不可用；`web_search`、`web_fetch` 不受影响。应用会明确报
“Chromium headless shell is not installed on this host.”，不是静默失败。

两条处理路径：

1. **平台侧（推荐，AM-01）**：在模板或受控初始化里安装 Chromium headless shell（revision 1248）
   和上述运行时库，并提供 `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`（或在
   `/workspace/.raytonebot/browsers` 预置）。应用侧不需要改代码；验收命令：
   `PLAYWRIGHT_BROWSERS_PATH=… node -e "…launch…"`，以及一次真实页面接管。
2. **用户态 sysroot（仅演示）**：用 `playwright-core install --with-deps --dry-run` 的包清单
   `apt-get download`，再 `dpkg-deb -x` 到 `/workspace/.raytonebot/sysroot`，运行时设置
   `LD_LIBRARY_PATH` + `PLAYWRIGHT_BROWSERS_PATH`。没有 root 校验、升级和维护都脆，不进入
   正式部署路径。

## 下次继续时

- 实施分支：`am-hosting`（基于 `raytone-1013-parity-pass`）。分支是否已推送或合并以 Git 状态为准；本文记录的首次部署不代表后续提交已部署。
- 部署状态在本机 `.agentmatrix/deployment.json`（gitignored），资源 ID 见上文；换机器后
  `am:deploy` 会按名称/Workspace 重新发现并接管。
- 重新部署：`export ARIADRA_API_KEY=…`（Console → API Keys），
  `npm run am:deploy -- --clean`；看状态 `npm run am:status`；刷新入口 `npm run am:preview`；
  恢复暂停 `npm run am:wake`；下线 `npm run am:stop`。
- 下一步优先级：AM-01 的浏览器/依赖模板 → AM-03 常驻策略 → AM-04 稳定鉴权入口 →
  RT-02 数据归档与恢复。

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

2026-11-01 显式交付版本在应用内新增 `/workspace/.raytonebot/data.artifact-versions/`（与 data 同级、主机私有）。保留/迁移时需同时保存元数据和字节；本地版本功能不会补齐本页尚未完成的独立备份、持久卷或 UID 隔离验收，未据此更新部署结论。


## 模型配置持久化代码（2026-10-23，未部署验证）

现有数据目录对应的私密存储是 `/workspace/.raytonebot/data.provider-secrets/`，设置页保存配置与加密密钥，重启或仅替换应用目录会保留。保存功能在 sandbox 模式下要求现有 Linux 隔离检查通过；本环境尚未完成独立 Agent UID/网络隔离，不能据本机回归宣称安全云端保存已验收。新建环境仍需持久卷或受信任的独立秘密恢复；普通数据备份不含这个目录。详见 [Provider 存储边界](product/12-provider-credentials-proposal.md)。
