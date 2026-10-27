# RaytoneBot

RaytoneBot 是一个单用户 AI 工作助手。你可以在浏览器里给 Bot 下达任务，查看执行过程、处理审批，并预览或下载生成的文件。它支持本机运行，也提供云端部署脚本。

## 能做什么

- **与不同 Bot 工作**：内置 Raer（Pi）、Tonny（Claude Code）、Bob（Codex），支持独立人设、模型和 MCP/文本 Skills 分配，以及在同一对话里邀请成员协作、一层只读委派。本机还可选用 DeepSeek Harness（DSH）。
- **跟进任务**：查看文本、思考、工具调用和计划；回答问题、批准操作、停止执行或排队追问。
- **管理会话和产物**：恢复与搜索历史，查看工作区文件，预览代码、Markdown、媒体、交互 HTML 和结构化表单，将文本产物保存为文档。
- **连接持续工作能力**：配置 IM 频道、远程 MCP、分范围记忆和例行任务；可显式引用其他聊天供 Agent 回查。有浏览器运行环境时可查看画面、接管操作，并通过 Login Vault 逐次授权填入登录信息。

各能力的实现、验收和部署范围见 [路线图](docs/product/03-roadmap.md) 与 [验收记录](docs/product/08-acceptance.md)。例行任务只在主机运行时按时触发；云环境休眠期间需要外部唤醒。DSH 目前仅支持本机。

## 本机启动

需要 **Node.js 22.19+** 和 npm。

当前 Git 仓库未收录 `vendor/**/dist/`。新 clone 或 worktree 需先从完整工作副本补齐这些冻结构建产物，`npm install` 不会生成它们；目录清单见 [依赖准备](docs/product/04-dependency-exit.md#完整工作副本要求)。已有完整工作副本可直接运行：

```bash
npm install
npm run dev
```

打开 **http://127.0.0.1:5188/**。Vite 同时启动前端和 Node Agent 主机，不需要另起后端。

首次使用，在设置 →「模型服务」中配置服务商、模型和 API key，点击保存后由主机加密持久化。输入框留空保留已存密钥，删除需显式操作；浏览器不保存或回读密钥。也可在启动进程的环境中提供指定变量，内置 DeepSeek 配置使用 `DEEPSEEK_API_KEY`。配置与密钥存于 `<dataDir>.provider-secrets/`，不包含在普通数据备份中，恢复方法见 [凭据说明](docs/product/12-provider-credentials-proposal.md)。Bot 专属模型优先于默认服务；停用服务会阻止继续调用，但保留配置和凭据。

Pi SDK 随项目依赖安装。Claude Code、Codex 和 DSH 需要另行安装相应 CLI；界面会报告不可用的引擎。安装要求、模型来源和权限规则见 [引擎与权限](docs/product/10-agents-and-permissions.md)。

默认所有 Bot 在项目目录中工作，以当前用户权限执行；本机默认对修改操作请求审批。需要把工作文件与应用分开时，可这样启动：

```bash
RAYTONEBOT_WORKSPACE_ROOT="$HOME/raytonebot-workspace" npm run dev
```

这会建立按引擎角色划分的目录与共享目录；目录分开不等于操作系统隔离。

| 配置 | 用途 |
| --- | --- |
| `RAYTONEBOT_WORKSPACE_ROOT` | 角色工作区和共享目录的根路径 |
| `RAYTONEBOT_WORKSPACE` | 未设置工作区根路径时，指定共用工作目录 |
| `RAYTONEBOT_DATA_DIR` | 产品数据目录，默认 `~/.raytonebot/data` |
| `RAYTONEBOT_CLAUDE_BIN` / `RAYTONEBOT_CODEX_BIN` / `RAYTONEBOT_DSH_BIN` | 指定不在 PATH 中的 CLI 入口 |

构建后在本机预览（先停止占用同一端口的 dev 服务）：

```bash
npm run build
npm run preview
```

仍打开上述 HTTP 地址。不要直接用 `file://` 打开 `index.html`，否则浏览器会阻止 ES 模块加载。

## 云端部署

| 路径 | 文档与边界 |
| --- | --- |
| AgentSphere | [部署运维手册](docs/product/06-deployment-runbook.md)：部署、暂停/唤醒、备份与恢复；包含独立 Agent/browser UID 和网络隔离配置 |
| AgentMatrix | [部署记录与命令](docs/agentmatrix-deployment.md)：已有首个可运行部署；浏览器依赖、隔离、常驻策略及完整恢复仍有缺口 |

实例地址、凭据位置和部署证据由各部署文档维护。本机验证通过不代表云端已更新。

## 开发与验证

改代码前先读 [AGENTS.md](AGENTS.md)，再按 [产品文档索引](docs/product/README.md) 找到相关规范。

| 命令 | 用途 |
| --- | --- |
| `npm run build` | TypeScript 检查与生产构建 |
| `npm test` | 主机、引擎、事件映射、前端状态及部署适配回归 |
| `npm run check:local` | 检查已启动的本机服务，不调用模型 |
| `node scripts/cloud-preview.mjs --check` | 云入口鉴权与请求边界检查，不部署 |

打开 [开发场景预览](http://127.0.0.1:5188/?devtools=1) 可逐项检查工具、审批、错误、重试、中断和产物等界面状态。真实任务经 `runPiTurn()` 进入主机；`runtime.transport` 保持 `"replay"`，它控制的是开发场景来源。

| 目录 | 职责 |
| --- | --- |
| `src/pi/` | Node 主机、引擎、权限、存储、IM、浏览器与例行任务 |
| `src/runtime/`、`src/agent-shell.tsx` | 前端状态与会话恢复 |
| `src/harness/adapters/piAdapter.ts` | Pi/CLI 事件到 AgentUX 的映射 |
| `src/components/` | 现有界面组件，按所属功能扩展 |
| `scripts/agentsphere/`、`scripts/agentmatrix/` | 两条部署路径 |
| `docs/product/` | 产品范围、架构、路线图、决策与验收 |
| `vendor/` | 冻结的 AgentUX SDK 与导出合同构建产物 |

前端基于 Vite、React、TypeScript，最初分叉自 AgentCanvas 导出，现已独立维护。来源、许可和依赖边界见 [依赖说明](docs/product/04-dependency-exit.md)。
