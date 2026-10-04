# RaytoneBot 产品文档

RaytoneBot 是运行在 AgentSphere 云沙箱上的单用户 AI 工作助手：在浏览器里下达任务，查看流式执行过程，审批修改操作，检查和取回产物。所有开发由 AI 编程工具（Codex / Claude Code）完成，因此本目录同时是 AI 的工作说明书。

## 阅读顺序

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [01-product-brief.md](01-product-brief.md) | 定位、用户、功能范围、非目标 | 理解“要做什么” |
| [02-architecture.md](02-architecture.md) | 当前与目标架构、模块所有权、数据位置 | 改服务端、接口、存储前 |
| [03-roadmap.md](03-roadmap.md) | 最快路径、里程碑、任务卡、当前进度 | **每次开始工作先读** |
| [04-dependency-exit.md](04-dependency-exit.md) | 如何脱离 AgentCanvas 与各参考仓库 | 动 `vendor/`、导出残留代码前 |
| [05-ai-workflow.md](05-ai-workflow.md) | AI 开发规则、任务模板、完成标准 | 每次派任务给 AI |
| [06-deployment-runbook.md](06-deployment-runbook.md) | AgentSphere 部署、续期、备份、销毁 | 部署或排查云端 |
| [07-decisions.md](07-decisions.md) | 架构决策记录（ADR） | 想改技术路线前 |
| [08-acceptance.md](08-acceptance.md) | 验收清单与检查命令 | 宣布完成前 |
| [09-lessons.md](09-lessons.md) | 踩坑记录，按主题检索 | 排障时 |
| [10-agents-and-permissions.md](10-agents-and-permissions.md) | 三个预置角色、多引擎接入、权限模型 | 改引擎、审批、权限前 |
| [11-parity.md](11-parity.md) | 参考项目源码基线、功能/UX 差距与模块验收 | 继续对齐 OpenBot / OpenMuse 时 |

## 当前状态（2026-10-03）

- 代码：AgentCanvas 导出的 React/Vite 前端 + 内置 Pi 运行时，本机与云端均可启动。
- 云端：<https://5188-id705on7k0a1ya1d90icj.agentsphere.run>（Basic Auth，凭据见本机 `.agentsphere/access.json`）。超时自动暂停；返回 502 时执行 `scripts/agentsphere/sandbox.py wake`。
- 已验证（本机）：真实模型任务（DeepSeek）、三个角色（Pi / Claude Code / Codex）、执行前审批、权限分级、设置面板与头像的浏览器验收。
- 已验证（云端）：Pi / Claude Code 真实任务、跨 Agent 协作、会话持久化（暂停/唤醒、进程重启）。Codex 用 DeepSeek key 运行，无需登录。平台限制与待决事项见根目录 [issue.md](../../issue.md)。

## 与旧文档的关系

`docs/` 根目录下的 `feasibility.md`、`openagentcore-assessment.md`、`nightly-openbot-assessment.md`、`agentsphere-deployment.md` 是调研与实验记录，保留作为证据，不再作为开发依据。结论已收敛进 [07-decisions.md](07-decisions.md)。
