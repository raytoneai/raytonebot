# RaytoneBot 产品文档

RaytoneBot 是一个支持本机与云端部署的单用户 AI 工作助手。运行方法见根目录 [README](../../README.md)；本目录维护产品范围、工程约束和验证依据。

## 按任务阅读

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [01 产品定义](01-product-brief.md) | 用户、核心闭环、产品范围与非目标 | 理解要做什么 |
| [02 架构](02-architecture.md) | 运行链路、模块所有权、接口与数据位置 | 改服务端、接口、存储前 |
| [03 路线图与进度](03-roadmap.md) | 近期进展、未完成任务与历史日志 | 继续非平凡工作前 |
| [04 依赖说明](04-dependency-exit.md) | AgentCanvas 来源、vendor 与参考项目边界 | 动依赖或导出残留前 |
| [05 AI 开发工作流](05-ai-workflow.md) | 开发约束、任务模板与完成标准 | 开始开发和提交前 |
| [06 AgentSphere 运维](06-deployment-runbook.md) | 部署、续期、备份与恢复 | 操作 AgentSphere 环境时 |
| [07 决策记录](07-decisions.md) | 已采纳的技术取舍与条件 | 改技术路线前 |
| [08 验收清单与记录](08-acceptance.md) | 检查命令、验证方法、证据与限制 | 验证和判断完成范围时 |
| [09 踩坑记录](09-lessons.md) | 已知故障与用户纠正 | 按主题排障时 |
| [10 引擎与权限](10-agents-and-permissions.md) | Bot 身份、Pi/Claude/Codex/DSH、审批与隔离 | 改引擎、Bot 或权限时 |
| [11 参考项目对齐](11-parity.md) | 固定版本的历史对照与后续补证 | 回查竞品研究依据时 |
| [12 Provider 凭据方案](12-provider-credentials-proposal.md) | 模块问题清单、主机密钥持久化与恢复边界 | 接续模型服务与凭据保存工作时 |

## 部署文档

- **AgentSphere**：[运维手册](06-deployment-runbook.md) 维护操作步骤，实例定位以本机部署状态文件为准。
- **AgentMatrix**：[部署记录](../agentmatrix-deployment.md) 维护 `am-hosting` 分支的已实现路径、首次部署证据和待补能力；[最小改造需求](../agentmatrix-hosting-minimal-requirements-2026-10-19.md) 保留平台与应用的完整验收目标，[可行性评估](../agentmatrix-platform-research-2026-10-19.md) 保留研究依据。首个部署已完成，不等于正式迁移或功能验收完成。

## 如何判断文档是否仍适用

根 README 只介绍项目和使用入口；当前工作进度集中在 [03](03-roadmap.md)，验收证据集中在 [08](08-acceptance.md) 及其链接的记录。接口、命令和默认值应与代码核对。新增进展时直接修正对应的现行说明，避免只在页首追加更正、让正文继续给出相反指引。

带日期的进度日志、验收记录、ADR 和调研报告描述当时的结果。后续实现应链接到新证据，不把过去的“未部署”当作当前状态，也不把本机实现或 HTTP 200 当作线上功能已验证。本文不维护重复的能力完成率、测试数量或在线地址。

`docs/` 根目录的可行性、竞品、浏览器和工具调研保留为历史依据；其中的建议不是自动生效的开发要求。已采纳的决策见 [07](07-decisions.md)，后续任务见 [03](03-roadmap.md)。
