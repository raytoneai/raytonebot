# OpenDuet README 定位与运行方式说明（带来源）

USER_KEEP

## 研究范围与依据

- 唯一来源：CopilotKit/OpenDuet 仓库 README.md 原始文件
- URL：https://raw.githubusercontent.com/CopilotKit/OpenDuet/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md
- 提交号：`677e0fcd148d80b99dd788c6d6f9c1c9f40a72db`
- 读取方式：原文抓取（完整读取，约 24.6k 字符）；访问时间为本次会话，未记录具体日期
- 重要限制：**以下全部是 README 的自述（来源声明），本次没有克隆仓库、没有安装依赖、没有实际启动服务，因此未做任何运行验证。**

## 摘要（约150字）

OpenDuet 是 CopilotKit 开源的主动式智能体，定位为每个 agent 拥有独立电脑、在你离开时继续工作、在发送/支付/签署/删除前先请你批准，构建于 OpenBot 与 CopilotKit 之上，自称早期开发阶段。运行需 Docker、Bun 1.3+、Node、模型密钥，以及必需的 CopilotKit Intelligence 项目；在仓库根目录 clone 后执行 `cp .env.example .env`、`bun install`，用 `npx copilotkit login`、`project select` 和 `bun openbot/scripts/setup-learning.ts` 完成配置，填好模型密钥后 `bash scripts/start.sh`，访问 http://localhost:3010。README 称暂无托管部署方式和 OpenDuet 镜像。

## README 声明要点

### 定位

- 标题自述："An open-source proactive agent that gets your work done and keeps you in the loop"。
- 基于 OpenBot（CopilotKit 开源、可自托管的 agent 平台）与 CopilotKit 构建；徽章标注 License: MIT、Status: early development。
- 关键主张：主动（不等被问，先给晨间简报）、每个 agent 有自己的电脑（浏览器、`/workspace`、shell）、行动前先征求同意、看不到你的密码、检查外发内容、可自行托管并自选模型。
- 成熟度自述：当前"as OpenBot with OpenDuet's name, Bots and skills on top"；README 称下列能力"works today"，但同一份文本也称项目早期、正在活跃开发。
- 与 Anthropic 无关联：README 明示其为独立项目，未获 Anthropic 认可。

### 运行方式（Quick start）

前置条件（README 声明）：Docker、Bun 1.3+、Node（供 `npx` 运行 CopilotKit CLI）、一个模型密钥、一个 CopilotKit Intelligence 项目；并强调 Intelligence **必需**，无密钥服务器不会启动，免费 Developer 计划即可。所有命令在仓库根目录执行。

1. `git clone https://github.com/CopilotKit/OpenDuet.git` → `cd OpenDuet` → `cp .env.example .env` → `bun install`
2. `npx --yes copilotkit@latest login` → `npx --yes copilotkit@latest project select` → `bun openbot/scripts/setup-learning.ts`
   - 说明：`project select` 写入 `CPK_INTELLIGENCE_API_KEY` 等；服务器实际读取 `INTELLIGENCE_API_KEY`，由最后一条命令补全，并确保存在 `openbot` Learning 容器。
3. 在 `.env` 填模型密钥：默认 Bot 使用 OpenAI `gpt-5.6-terra`（配置于 `openbot/examples/openduet/model.yaml`），故默认 `OPENAI_API_KEY=sk-...`；换 Anthropic 则设 `BOT_PROVIDER=anthropic` 与 `ANTHROPIC_API_KEY`。
4. `bash scripts/start.sh`，打开 http://localhost:3010 ；`bash scripts/stop.sh` 停止（加 `--keep-computers` 保留 Bot 电脑）。
5. README 明确：托管/部署指南与 OpenDuet 镜像"尚未发布"，上述 Quick start 是当前唯一受支持的方式；`openbot/docs` 里的 Docker/Helm 指南部署的是纯 OpenBot，不是 OpenDuet。

其他声明（非运行验证）：端口 5432 占用时改 `POSTGRES_PORT` 与 `DATABASE_URL`；可用 `openbot/scripts/fake-google/server.ts` 在无 Google 账号时试用 Gmail/日历；`COPILOTKIT_TELEMETRY_DISABLED=true` 或 `DO_NOT_TRACK=1` 关闭遥测。

## 证据与来源表

| 主张 | 出处 | 性质 |
| --- | --- | --- |
| 主动式智能体、基于 OpenBot/CopilotKit、MIT、早期开发 | README 开头与徽章 | 来源声明 |
| 前置条件含 Docker、Bun 1.3+、Node、模型密钥、必需 Intelligence 项目 | README「Quick start」首段 | 来源声明 |
| 安装与启动命令序列、`bash scripts/start.sh`、端口 3010 | README「Quick start」代码块 | 来源声明 |
| 默认模型 `gpt-5.6-terra` 位于 `openbot/examples/openduet/model.yaml` | README「Quick start」正文引用路径 | 来源声明（未打开该文件核对） |
| 无托管部署指南、无 OpenDuet 镜像 | README「Quick start」末段 | 来源声明 |

## 未覆盖与不确定性

- 未克隆仓库、未读取 `openbot/examples/openduet/model.yaml`、`.env.example`、`scripts/start.sh` 等实际文件，文中文件名与路径均转述自 README 文本。
- 未验证任何命令能否成功执行，也未验证默认模型名、端口、环境变量在源码中是否一致。
- README 提到"works today"的能力清单（晨间简报、Tasks、Make、Gmail/日历等）本次未做功能核实。
- 访问日期仅记为"本次会话"，未取系统时间以求准确。
