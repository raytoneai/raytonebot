# OpenDuet 的定位与运行方式

来源：CopilotKit/OpenDuet 仓库 README.md，提交 `677e0fcd148d80b99dd788c6d6f9c1c9f40a72db`
（https://raw.githubusercontent.com/CopilotKit/OpenDuet/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md）

**说明：以下全部为该 README 的自我陈述，仅据所读原文归纳，未做任何运行验证或源码核查。**

## 定位

README 称 OpenDuet 是开源、可自托管的「主动型」agent：基于 OpenBot 与 CopilotKit 构建，每个 agent 拥有自己的电脑（浏览器、文件、shell），可在网页、移动端、Slack 或 Teams 使用，可自选模型、数据留在自己的数据库；它会主动发晨间简报、区分「需要你」与「可以等」，并在发送、付费、签署、删除前先展示动作、等用户答复。README 同时标注其处于早期开发阶段，目前实际以 OpenBot 平台加 OpenDuet 的名称、Bots 与技能运行。

## 运行方式

README 的 Quick start 声明需要 Docker、Bun 1.3+、Node，一个模型 key，以及**必需**的 CopilotKit Intelligence 项目（缺其 key 服务器不启动）。步骤须在仓库根目录执行：克隆仓库、`cp .env.example .env`、`bun install`；用 `npx --yes copilotkit@latest login` 与 `project select` 选项目，再运行 `bun openbot/scripts/setup-learning.ts` 把 key 写入 `INTELLIGENCE_API_KEY`；在 `.env` 填入模型 key（默认 `OPENAI_API_KEY`，因示例 Bot 使用 `gpt-5.6-terra`）；最后 `bash scripts/start.sh` 启动 Postgres、各 Bot 电脑与 API/worker/app，打开 http://localhost:3010 。README 另称：尚无 OpenDuet 官方镜像或托管部署指南，Quick start 是当前唯一受支持的方式；`bash scripts/stop.sh` 停止服务并保留 Docker 卷中的数据。

## 两项目定位比较

新增来源：milind-soni/OpenMausBot README.md，提交 `8c663d2b7647dcea04a2278dd0f794f591ae95e0`
（https://raw.githubusercontent.com/milind-soni/OpenMausBot/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md）
同样只是 README 声明，未运行验证。

两者都以「每只 bot 有独立电脑、动手前先审批」为卖点，差别在形态与部署。OpenDuet 是自托管的网页/移动/IM 平台，需 Docker 与必需的 CopilotKit Intelligence，主打晨间简报等主动推送，自称早期开发阶段。OpenMausBot 是本地优先的 Electron 桌面聊天应用，自称开源 Grok Bot 替代品，直接驱动本机已装的 claude/codex/grok CLI，数据留在 `~/.openmausbot`，提供签名安装包，许可为 Apache 2.0。

---

用户备注：USER_KEEP
