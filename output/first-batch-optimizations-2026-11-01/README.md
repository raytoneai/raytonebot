# 首批优化与主代理 review

日期：2026-11-01（Asia/Shanghai）。实施基线：`75396ec125c439238749811d7a0f6c90876591bf`。用户授权三个快速子代理完成首批，主代理负责审查、整合与验证。既有竞品调研文档改动保留；未提交、推送或部署。

后续：用户授权独立提交和推送；为避开本地 `main` 上另外 19 个未推送提交，从远端基线单独整理至 `codex/research-optimizations`。冲突取舍与该较早基线的复验结果见[独立提交记录](../isolated-first-batch-push-2026-11-01/README.md)。下文仍描述原实施时的验证范围。

## 已完成

- 两条[任务 Skills](../../docs/task-skills/README.md)：带来源的研究报告、已有报告增量更新。复用现有保存/分配/按需读取，已分配给**本机 Raer**；其他 Bot、模型、权限未变。配置修改前备份，身份与备份位置见[安装记录](local-skill-install.json)。云端未安装。
- `publish_artifact({path, preserveVersion: true})`：显式保存 `.md`、`.txt`、`.pdf` 的交付字节；默认省略参数保持原行为。单文件 20 MiB、总字节 500 MiB，达到限制拒绝保存，不自动清旧版。
- 原 Output 支持历史版本选择、只读预览/下载，以及当前文件的正文、编辑、刷新。保存的 A/B 不随当前文件覆盖或删除而变化；版本元数据沿现有鉴权接口读取，群产物按真实会话和成员身份关联。
- 主机 sibling 目录 `<dataDir>.artifact-versions/` 保存字节/元数据；来源会话删除会清理所属版本。AgentSphere 现有备份加入该目录，拒绝链接并恢复私有权限；Provider/Vault 凭据仍排除。

范围和取舍见[原优化方案](../../docs/optimization-priorities-2026-11-01.md)、[ADR-057](../../docs/product/07-decisions.md)。未增加依赖、事件协议、服务、并行 UI 或模型配置。

## Review 中修正的主要问题

1. 区分原始、投影和群成员的产物身份；直接传递公共 runId，避免从带点的子轮次字符串猜父身份。同角色的不同 Bot 不共享版本查询结果。
2. 同路径 A/B 独立保留；历史标签不被普通写入刷新覆盖，切回当前文件仍保留稳定版本来源。主机返回已验证的 scope/path，解决 macOS `/var` 与 `/private/var` 别名导致当前文件入口丢失。
3. 保存失败不发成功事件；取消时回收已保存字节与元数据。捕获前后比较文件状态；配额计入孤立 `.bin`。文件名支持中文/空格。
4. 修复当前模式正文被编辑栏替代、元数据重试未重新加载、窄屏版本选择器高度被挤为零及长链接撑宽正文的问题；在真实页面而非仅组件截图中复验。历史版本的表单 JSON 只读显示，切回当前文件后原表单交互仍可用。
5. 备份恢复显式重设版本目录权限，避免 Python tar 解包过滤器移除私有目录模式。

## 验证结果

| 检查 | 实际结果 / 证据 |
| --- | --- |
| 类型检查与生产构建 | 通过；[build-final.log](build-final.log)。保留既有动态导入与 chunk 大小提示。 |
| 完整 Node 回归 | 733 项，732 通过、1 项 DSH 环境跳过、0 失败；[test-final.log](test-final.log)。末次 UI 修正另做下行定向检查。 |
| 最终 UI 定向回归 | 29/29 通过，含 Markdown/PDF、A/B→当前、当前文件更新、失败重试、历史表单只读、390px modal/长链接；[ui-final.log](ui-final.log)，[浏览器测试源码](../../src/runtime/outputVersions.browser.test.ts)。浏览器测试的 HTTP 边界使用受控响应，不冒充真实主机。 |
| 真实主机与真实模型历史页面 | A/B 下载逐字节核对，历史无编辑栏、当前有正文/编辑，删除临时源文件后旧版仍可读；[结果](version-browser-review.json)、[桌面](version-desktop.png)、[390px](version-mobile.png)。 |
| 既有场景 | 欢迎页 + 19 个事件场景 × 桌面/390px，40/40 通过，无页面错误/横向溢出；[fixture-results.json](fixture-results.json)。 |
| 文件与 HTTP 边界 | 重启读取、伪造/跨会话 404、HEAD/range、源链接/私有路径拒绝、真实群流程、配额、捕获变化、保存失败/取消回收、会话删除；[版本测试](../../src/pi/artifactVersions.test.ts)。 |
| Python 备份/运维 | 16 项，13 通过、3 项环境跳过；[backup-final.log](backup-final.log)。新增版本字节/元数据/权限恢复、链接拒绝与秘密排除检查。 |
| 本机与云入口策略 | [check:local](local-check.log)、[cloud-preview --check](cloud-check.log) 通过；后者是本地策略检查，不是云部署验收。 |

实际命令：`npm run build`、`npm test`；末次 UI 定向为 `node --test src/runtime/outputVersions.browser.test.ts src/runtime/outputPreview.test.ts src/runtime/artifactContent.test.ts src/runtime/workArtifacts.test.ts src/runtime/useOutputPanel.test.ts src/pi/piClient.test.ts`；在 `scripts/agentsphere` 下执行 `python3 -m unittest test_backup_data test_operations`；隔离主机 5197 执行 `RAYTONEBOT_URL=http://127.0.0.1:5197 npm run check:local`；`node scripts/cloud-preview.mjs --check`。浏览器脚本随本目录保存；它们依赖本次临时会话数据，属于验收证据而非新增产品测试服务。

## 真实模型对照：流程可用，质量收益尚未证明

沿用当前 `deepseek-flash`，不修改用户默认模型。隔离数据和工作区，使用既有凭据服务；只允许本次研究必要工具，测试写入审批限定临时 `report.md`。没有向模型发送私人报告或登录凭据。

- 固定 OpenDuet `677e0fc` README 做研究，再补充 OpenMausBot `8c663d2` README。普通请求与 Skill 各做两轮，随后精简过长的 Skill 说明并再做两轮，总计六次成功完成；每轮恰好一份显式交付。
- Skill 组实际调用 `read_skill`，不是只在配置中勾选；两组均保留 `USER_KEEP`，两次交付字节不同，第一次快照没有被第二次编辑覆盖。[最终对照记录](model-smoke.json)、[精简后日志](model-smoke-refined.log)、[报告文件](model-reports)。
- 第一版 Skill 过度展开。精简后研究报告从 3179 字符降到 1112 字符，但普通请求为 938 字符；精简后的研究正文仍有 292 个汉字，普通请求为 225，均未满足提示里的 150 字。此处只是可复查的单次输出计数，不是质量评分或统计收益。
- 只读取 README 的组明确来源范围；这些报告不等同于源码检查、项目运行或本文之前的完整竞品研究。

仍未完成真实模型对照的四类场景：部分来源失败、读取后文件被他人修改、审批拒绝、用户中止。主机测试覆盖部分失败/取消边界，但不能替代模型行为验证。也未对 Claude Code、Codex、DSH 做本次真实模型端到端验收。

## 保留的边界

- Markdown 仅冻结文件字节，不冻结外链；当前源文件被删除后，切到当前文件会如实失败，历史仍可读。
- 分支复制聊天事件不复制原会话的快照；无匹配版本时明确不可用。没有回滚覆盖、可视 diff、自动保存、HTML 关联资源或目录快照。
- 同 UID 本机并不提供对任意本地进程的强隔离。字节/元数据双文件保存不宣称数据库事务或断电后零丢失；孤立文件不进入交付查询，仍占配额。
- 云端 UID 隔离、持久卷、实际备份恢复未部署验收；AgentMatrix 仍沿原 runbook 的限制。Skill 的改善效果与上述未测场景继续保留为未验证。
