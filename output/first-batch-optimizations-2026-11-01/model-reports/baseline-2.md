# OpenDuet 与 OpenMausBot README 研读报告

> 用户备注：USER_KEEP

## 定位与运行方式（约150字）

OpenDuet 是 CopilotKit 基于 OpenBot 的开源、可自托管的主动式 agent：不等被提问就主动给出晨间简报并推进任务，发送、付款、签署、删除前一律先请示，每个 agent 都有独立浏览器、`/workspace` 和 shell。

运行（README 的 Quick start）：准备 Docker、Bun 1.3+、Node、模型密钥，以及必需的 CopilotKit Intelligence 项目；克隆仓库后 `cp .env.example .env`、`bun install`；用 `npx copilotkit@latest login` 与 `project select` 选项目，再跑 `openbot/scripts/setup-learning.ts` 写入 `INTELLIGENCE_API_KEY`；在 `.env` 填 `OPENAI_API_KEY`（默认模型 `gpt-5.6-terra`）；执行 `bash scripts/start.sh`，打开 http://localhost:3010 。

## 与 OpenMausBot 的定位比较（约150字）

两者都开源自托管、给每个 agent 配一台自己的计算机、动作前请示，但取向不同。OpenDuet 主打「主动」：服务端 + Web/Slack/Teams，Docker + Postgres 部署，必依赖 CopilotKit Intelligence 存线程与记忆，默认 OpenAI 模型，晨间简报与待办分诊是核心卖点。OpenMausBot 主打「聊天应用里的一队 bot」：Electron 桌面端（macOS/Windows/Ubuntu）或 npm/`npx` 一键起，直接驱动本机已登录的 `claude`/`codex`/`grok` CLI，本地优先、数据留在 `~/.openmausbot`，更偏对话式协作 + 定时/Webhook 触发器，Apache-2.0。

## 来源

- OpenDuet 原文：https://raw.githubusercontent.com/CopilotKit/OpenDuet/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md
- OpenDuet 提交号：`677e0fcd148d80b99dd788c6d6f9c1c9f40a72db`（677e0fc）
- OpenMausBot 原文：https://raw.githubusercontent.com/milind-soni/OpenMausBot/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md
- OpenMausBot 提交号：`8c663d2b7647dcea04a2278dd0f794f591ae95e0`（8c663d2）

## 说明

- 以上内容仅为两个提交 README 的**文字声明**，本次**未做任何安装或运行验证**，未执行 shell 命令，也未访问仓库其他文件。
- README 自述项目处于 early development（早期开发）阶段，能力清单为其"今天可用"的说法，未经独立核实。
- README 声明尚未提供 OpenDuet 的托管/部署指南与官方镜像，`scripts/start.sh` 是当前受支持的上手方式。
- OpenMausBot README 自述「Early but real」：macOS/Windows/Ubuntu 24.04 已有发布构建，Ubuntu 仍为 beta（Wayland 下本机控制被安全门禁关闭），托管/移动端连通性仍在建设。
