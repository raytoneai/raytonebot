# OpenDuet README 定位与运行方式说明（含与 OpenMausBot 的定位比较，带来源）

USER_KEEP

## 研究范围与依据

- 来源一：CopilotKit/OpenDuet 仓库 README.md 原始文件
  - URL：https://raw.githubusercontent.com/CopilotKit/OpenDuet/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md
  - 提交号：`677e0fcd148d80b99dd788c6d6f9c1c9f40a72db`
  - 读取方式：原文抓取（完整读取，约 24.6k 字符）
- 来源二（本次更新新增）：milind-soni/OpenMausBot 仓库 README.md 原始文件
  - URL：https://raw.githubusercontent.com/milind-soni/OpenMausBot/8c663d2b7647dcea04a2278dd0f794f591ae95e0/README.md
  - 提交号：`8c663d2b7647dcea04a2278dd0f794f591ae95e0`
  - 读取方式：原文抓取（分两段完整读取，共约 32.2k 字符）
- 访问时间为本次会话，未记录具体日期
- 重要限制：**以下全部是两份 README 的自述（来源声明），没有克隆任一仓库、没有安装依赖、没有启动任何服务，因此未做任何运行验证。**

## 本次更新记录（增量）

- 更新范围：新增来源二（OpenMausBot README，提交 `8c663d2`），新增「定位比较」一节及对应证据行；原 OpenDuet 摘要、运行步骤、证据表、未覆盖项均按原文保留，未改写措辞或顺序。
- 未删除或替换任何原有结论；`USER_KEEP` 保留在标题下。
- 新证据性质：仍为 README 声明，未做运行验证；两个项目的关系与差异只按各自 README 的自述并列陈述，本次未做独立核验。

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

## 定位比较：OpenDuet 与 OpenMausBot（约150字）

两者都自述为一个 bot 一台电脑、动手前先请你批准，但定位分岔：OpenDuet 由 CopilotKit 出品，是自托管的主动式服务（Web/Slack/Teams），依赖必需的 CopilotKit Intelligence 云项目，用 Docker + Bun 脚本在本地起服务，模型走 API key，MIT。OpenMausBot（原 OpenGrokBot）是本地优先的 Electron 桌面聊天应用，把已登录的 `claude`/`codex`/`grok` 本地 CLI 当引擎，数据留在 `~/.openmausbot`，按 bot 选模型与渠道，主要靠签名安装包分发，Apache 2.0（`enterprise/` 除外）。两者 README 均称早期。

| 维度 | OpenDuet（来源一声明） | OpenMausBot（来源二声明） |
| --- | --- | --- |
| 形态 | 自托管 Web 服务/app，支持 Slack、Teams | Electron 桌面应用（macOS/Windows/Ubuntu），另有 npm CLI 与服务器部署 |
| 依赖底座 | OpenBot 平台 + CopilotKit Intelligence（**必需**，无密钥不启动） | 本地 harness 服务（`127.0.0.1:8799`）+ App（`5199`），数据在 `~/.openmausbot` |
| 模型来源 | 模型密钥（默认 OpenAI `gpt-5.6-terra`，可换 Anthropic 等） | 复用本机已登录的 `claude`/`codex`/`grok` CLI，可接自定义 CLI 或其他 provider |
| 安装方式 | `git clone` + `bun install` + `bash scripts/start.sh`（README 称无镜像、无托管部署） | 直接下载签名安装包；或 `pnpm install` 后 `pnpm dev:server`/`pnpm dev`；或 `npx openmausbot` |
| 每个 bot 的电脑 | 容器：Chromium + `/workspace` + shell | 云 Linux 桌面（Boat）、隔离本地 VM，或经明示同意后用本机 |
| 批准机制 | 单一 gateway：策略 → 审计记录 → 执行，Allow once / Always allow / Refuse | 权限 broker：shell、改文件、提问以卡片形式 Allow / Deny / 回答 |
| 许可 | MIT | Apache 2.0（`enterprise/` 另有许可） |
| 成熟度自述 | early development / 早期、活跃开发 | "Early but real"，Ubuntu 为 beta |

## 证据与来源表

| 主张 | 出处 | 性质 |
| --- | --- | --- |
| 主动式智能体、基于 OpenBot/CopilotKit、MIT、早期开发 | README 开头与徽章 | 来源声明 |
| 前置条件含 Docker、Bun 1.3+、Node、模型密钥、必需 Intelligence 项目 | README「Quick start」首段 | 来源声明 |
| 安装与启动命令序列、`bash scripts/start.sh`、端口 3010 | README「Quick start」代码块 | 来源声明 |
| 默认模型 `gpt-5.6-terra` 位于 `openbot/examples/openduet/model.yaml` | README「Quick start」正文引用路径 | 来源声明（未打开该文件核对） |
| 无托管部署指南、无 OpenDuet 镜像 | README「Quick start」末段 | 来源声明 |

来源二（OpenMausBot，提交 `8c663d2`）新增证据：

| 主张 | 出处 | 性质 |
| --- | --- | --- |
| 定位为「开源 Grok Bot 替代」，独立项目，与 xAI/Meta/OpenAI/Manus 无关 | README 标题下方说明与文末 License 段 | 来源声明 |
| 每个 bot 有独立人格、模型、云电脑与已连应用；bot 跑在本机 `claude`/`codex`/`grok` CLI 上 | README「Why」小节 | 来源声明 |
| 本地优先：harness 服务在 `127.0.0.1`，转录与密钥存 `~/.openmausbot` | README「Why」小节 | 来源声明 |
| 安装包（dmg/exe/.deb/AppImage）或源码 `pnpm install` + `pnpm dev:server` / `pnpm dev` | README「Quick start」 | 来源声明 |
| 许可 Apache 2.0，`enterprise/` 另有许可；Cua Driver 等第三方组件另有条款 | README「License」 | 来源声明 |

## 未覆盖与不确定性

- 未克隆仓库、未读取 `openbot/examples/openduet/model.yaml`、`.env.example`、`scripts/start.sh` 等实际文件，文中文件名与路径均转述自 README 文本。
- 未验证任何命令能否成功执行，也未验证默认模型名、端口、环境变量在源码中是否一致。
- README 提到"works today"的能力清单（晨间简报、Tasks、Make、Gmail/日历等）本次未做功能核实。
- 访问日期仅记为"本次会话"，未取系统时间以求准确。
- 本次新增：未读取 OpenMausBot 的 `docs/`、`server/contracts.ts`、`package.json`、`LICENSING.md`、`enterprise/LICENSE`，也未打开其 releases；端口 8799/5199、Node 24+、pnpm 等要求均转述自 README。
- 两个项目的对比只基于两份 README 的自述，未比较实际代码、功能成熟度或性能；表中「形态」「电脑」等差异是来源声明并列，不是独立验证的结论。
- OpenDuet README 提到的默认模型名 `gpt-5.6-terra`、OpenMausBot 提到的营收/发布时间背景，本次均未独立核实。
