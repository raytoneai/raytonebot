# 当前功能与文档漂移核对（2026-11-01）

结论：核对发现的漂移已修正，主要涉及入口文档未跟进近期功能、启动前置失效、运维命令和旧模块描述残留。本轮同步 README、AGENTS、产品定义/索引、架构、路线图、验收、依赖/权限说明和部署文档；不修改产品代码、用户数据、模型或部署。

核对基线为本机 `main` 的 `62e4e73` 及当前工作树。初次核对避开另一会话正在编辑的架构、路线图与验收文档；用户随后要求补齐并提交，本轮仅修改这些文件中独立的漂移段落。另一会话的产品代码、测试、修复记录、主机退出与执行预算说明均保留在工作区，不纳入本次文档提交。不推送或部署。

## 已修正

| 漂移 | 处理与依据 |
| --- | --- |
| README 称 vendor 构建产物不在 Git，新 clone 需手工复制，并链接到已删除章节 | 改为仓库已分发五个 `file:` 依赖的冻结产物；核对 `git ls-files vendor`、[包清单](../../package.json)及[依赖说明](../../docs/product/04-dependency-exit.md#冻结产物的仓库分发) |
| 首页、产品定义及 owner 表缺近期能力入口 | 补 RSL、显式交付版本、任务 Skills、记忆维护/导出及项目交接入口；明确默认关闭、显式保存、手工安装和本机验证边界。依据 [learning](../../src/pi/learning/service.ts)、[artifactTool](../../src/pi/artifactTool.ts)、[memories](../../src/pi/memories.ts)、[memory-backup](../../scripts/memory-backup.mjs) 和既有 ADR-055/056/057 |
| 引擎说明停留在早期记忆与设置能力 | 补分页、原位替换、来源记录、压缩后下一轮刷新及 RSL 人工审核；区分用户记录的核验日期与主机实际核验。依据 [Memory](../../src/components/settings/MemorySection.tsx)、[Learning](../../src/components/settings/LearningSection.tsx) 和主机实现 |
| 产品非目标笼统排除语音 | 区分输入框已有的浏览器语音转文字与尚未提供的实时通话；依据 [ComposerFrame](../../src/components/agent-preview/ComposerFrame.tsx) 的 SpeechRecognition 接线，不宣称重新完成麦克风或真机验收 |
| 当前说明把 Pi 工具总数固定成 7/8 项，混淆 SDK 与产品 MCP | 依赖、运维、权限、架构与验收说明统一为七个文件/命令工具加按上下文启用的主机工具；SDK MCP 未启用不代表产品无远程 MCP。依据 [piSdkBridge](../../src/pi/piSdkBridge.ts) 的工具组装 |
| 第三方说明引用已删除的 scaffold vendor 副本，缺 Pi 许可入口 | 删除失效目录描述，补当前 contract 冻结包与两项 Pi 1.0.1 依赖；Pi 的 MIT 声明按已安装包元数据核对，不做新的法律解释 |
| AgentMatrix 说明仍像只在 `am-hosting` 分支；干净发布描述不完整 | 明确首次实施分支与当前 `main` 脚本的区别，补 HEAD checkout 独立安装锁文件依赖的行为；依据 [release.mjs](../../scripts/agentmatrix/release.mjs) 和 Git 历史。首期云端缺口保持原结论 |
| AgentSphere 命令把命令/参数拼成 `$S`，且将子命令选择写成 shell 管道 | 改为 bash/zsh 函数、独立操作表、明确 `--state-dir` 和实际部署命令；依据 [sandbox.py](../../scripts/agentsphere/sandbox.py)、[deploy.py](../../scripts/agentsphere/deploy.py) 的解析器 |
| 首次 AgentSphere 实验容易被读成当前内存会话/实例状态 | 明确标为历史快照，旧结果保留，现行入口链接到运维与验收文档；不查询或改动线上实例 |
| README 旧依赖锚点、LCU 报告指向 Markdown 行号的锚点失效 | 改为当前存在的章节锚点；历史调研结论不改写 |

## 后续补齐（已完成）

初次留下的五处现行说明已按用户后续要求补齐。只暂存本轮修改的段落，不覆盖或提交另一会话的修复说明。

| 文档位置 | 完成的同步 |
| --- | --- |
| [02 架构](../../docs/product/02-architecture.md)「运行架构」图及「请求接口」标题 | 明确 `piHttpHost.ts`、`piRuntimeController.ts`、`piSdkBridge.ts` 的职责，保留 `piHost.ts` 的兼容导出说明；同步 DSH 调用位置、LRU 归属与框架无关 handler 的引用 |
| [02 架构](../../docs/product/02-architecture.md)「运行架构」「安全边界」 | 明确七个文件/命令工具走隔离 worker，计划、提问和其他主机工具在主机执行；删除把计划/提问按固定总数编号的表述 |
| [08 验收](../../docs/product/08-acceptance.md) C5 | 验证基础工具、普通轮次提问及当前配置应启用的能力，不固定工具总数 |
| [08 验收](../../docs/product/08-acceptance.md) E1 | 更新为侧栏选择内置/自定义 Bot、Logo 创建与头像菜单编辑；核对刷新和历史恢复，历史实测记录保留 |
| [03 路线图](../../docs/product/03-roadmap.md)「当前工作入口」 | 更新核对日期，补 RSL、交付版本、记忆维护/备份与任务 Skills 的入口和验证限制；新增本轮文档日志，保留历史任务记录 |

## 验证及边界

- 对根 Markdown 与 `docs/` 共 67 份文档进行本地链接/章节扫描，初次发现两处失效章节锚点，无缺失的相对目标文件。首次修复后连同本记录共检查 68 份文档、743 处相对链接及其中 26 处 Markdown 章节锚点，均通过；补齐后检查暂存版本的 68 份文档、745 处相对链接与 27 处章节锚点，全部通过。跳过 29 处绝对机器路径；未检查外站 URL 或源码行号的语义。
- 当前产品与部署文档中的 12 个 `npm run` 脚本名均存在于 `package.json`；未执行这些开发/部署命令。
- 两段修订的 shell 示例均通过 `bash -n` 和 `zsh -n`。`sandbox.py --help`、`sandbox.py status --help`、`deploy.py --help` 通过；sandbox 在解析参数前要求环境变量，首次无环境执行被拒，随后仅为 `--help` 使用虚拟 key，通过参数解析后即退出，未调用平台。
- 对照源码、包元数据及 Git 清单核对功能、默认值、owner、路径和命令。`git diff --check` 通过。
- 纯文档改动，没有运行构建、完整测试、真实模型、浏览器或云端功能验收，也未启动/停止现有服务。另一会话的运行结果不作为本轮验证。
