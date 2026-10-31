# OpenDuet README 研读报告

> 用户备注：USER_KEEP

## 定位与运行方式（约150字）

OpenDuet 是 CopilotKit 基于 OpenBot 的开源、可自托管的主动式 agent：不等被提问就主动给出晨间简报并推进任务，发送、付款、签署、删除前一律先请示，每个 agent 都有独立浏览器、`/workspace` 和 shell。

运行（README 的 Quick start）：准备 Docker、Bun 1.3+、Node、模型密钥，以及必需的 CopilotKit Intelligence 项目；克隆仓库后 `cp .env.example .env`、`bun install`；用 `npx copilotkit@latest login` 与 `project select` 选项目，再跑 `openbot/scripts/setup-learning.ts` 写入 `INTELLIGENCE_API_KEY`；在 `.env` 填 `OPENAI_API_KEY`（默认模型 `gpt-5.6-terra`）；执行 `bash scripts/start.sh`，打开 http://localhost:3010 。

## 来源

- 原文：https://raw.githubusercontent.com/CopilotKit/OpenDuet/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md
- 提交号：`677e0fcd148d80b99dd788c6d6f9c1c9f40a72db`（677e0fc）

## 说明

- 以上内容仅为该提交 README 的**文字声明**，本次**未做任何安装或运行验证**，未执行 shell 命令，也未访问仓库其他文件。
- README 自述项目处于 early development（早期开发）阶段，能力清单为其"今天可用"的说法，未经独立核实。
- README 声明尚未提供 OpenDuet 的托管/部署指南与官方镜像，`scripts/start.sh` 是当前受支持的上手方式。
