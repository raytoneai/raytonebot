# 任务 Skills

这些文件是现有 RaytoneBot Settings 可保存的 `name`、`description`、`instructions` 文本，不是 Codex `SKILL.md`，也不会因放进仓库而自动安装。报告与项目交接使用现有 Bot 分配、联网/文件工具和 `publish_artifact`；记忆审计复用现有记忆工具，不新增自动导入器、权限或模型设置。

| Skill | 用途 | 安装状态 |
| --- | --- | --- |
| [有来源的研究报告](source-backed-research-report.md) | 研究并登记单文件报告 | 首批已安装到本机 Raer |
| [已有报告增量更新](incremental-report-update.md) | 保留原内容，按新证据更新报告 | 首批已安装到本机 Raer |
| [记忆审计](memory-audit.md) | 完整读取可见记忆，审阅疑似冲突并执行获准的具体变更 | T6.10 第三批已安装到本机 Raer |
| [项目交接](project-handoff.md) | 显式维护持续项目的目标、进度、决策理由和下一步，回读后登记交接文件 | T6.10 第三批已安装到本机 Raer |

2026-11-01 首批两条已通过原服务保存并分配给**本机 Raer**，重新加载后的 `read_skill` 两条均可读取；其他 Bot、模型和权限未变。配置修改前已备份，安装身份及回退文件位置见[本机安装记录](../../output/first-batch-optimizations-2026-11-01/local-skill-install.json)。其他主机仍按以下步骤安装，未同步到云。

## 手工安装与分配

同日 T6.10 第三批将记忆审计与项目交接通过原服务保存并分配给本机 Raer；重新加载后 `read_skill` 可读取，原 Skills、其他 Bot、Raer 模型和权限逐项比对不变。修改前备份及新 Skill 身份见[安装记录](../../output/memory-improvements-2026-11-01/local-skill-install.json)。[隔离接续检查](../../output/memory-improvements-2026-11-01/project-handoff-check.json)确认文件冲突保护、用户内容保留和交付字节恢复；它使用受控执行器，不证明真实模型会遵循 Skill。

1. 打开 RaytoneBot 的 Settings → **MCP & Skills**，选择 **Add Skill**。
2. 将每个文件的 `name`、`description`、`instructions` 三段分别复制到对应字段，保持 Enabled 后保存。现有校验限制为：name ≤ 80、description ≤ 300、instructions ≤ 16,000 字符；不要粘贴本文件标题或说明。
3. 打开目标 Bot 的 **Edit** → **Engine, model and capabilities** → **Skills**，勾选对应 Skill 并保存。只分配实际要验收的 Bot；Skill 文本不改变该 Bot 的模型、工具或权限。
4. 首批研究或更新任务的最终交付应是一个 `.md`、`.txt` 或 `.pdf` 文件，并由 Skill 要求用 `publish_artifact({path, preserveVersion: true})` 登记；以工具成功回执为准。记忆审计不要求另建报告文件；安装前确认运行主机支持分页 `recall_memories` 和 `remember` 的 `replaceId`、`expectedText`、`evidence` 参数，不能用先删后建替代。用户要求审计时才使用；仍沿用既有审批和可见范围。
5. 项目交接只在用户明确要求持续项目记录或交接时使用，默认维护已知项目目录的一份 `PROJECT.md`；云端共享路径须由主机提供。保存并回读核验后才登记交付版本；新会话仍需拿到确切路径并完整读取，安装 Skill 不会自动扫描或加载旧项目。

## 六场景手工对照记录

使用现有 DeepSeek Flash、相同权限与输入资料，在隔离会话/工作区分别运行普通请求和分配 Skill 的请求。正常研究与更新已实测；第一版 Skill 过度展开，精简文字后重跑这两步，输出缩短但仍超过要求的 150 字。普通请求也超出字数，因此目前只能确认流程可用，**不能认定 Skill 提升了质量**。日志、报告与限制见[首批验收记录](../../output/first-batch-optimizations-2026-11-01/README.md)。

| 场景 | 固定输入/操作 | 普通请求 | 使用 Skill | 核对证据与限制 |
| --- | --- | --- | --- | --- |
| 正常研究 | 固定 OpenDuet 提交的 README，要求带来源单文件报告 | 文件/登记成功，保留 USER_KEEP | 读取 Skill、文件/登记成功，保留 USER_KEEP | 来源范围明确；两组字数均超限；只验证 README 研究，不等于源码或运行核验 |
| 部分来源失败 | 保留一个可访问来源，再提供一个不可访问/被拒来源 | 未实测 | 未实测 | 是否明确列失败与未覆盖；不得假称完整 |
| 更新已有报告 | 在原报告补充固定 OpenMausBot README 的结论 | 更新/登记成功，USER_KEEP 保留 | 读取 Skill、更新/登记成功，USER_KEEP 保留 | A/B 为不同字节，第一份交付未被覆盖；样本不足以比较可靠性 |
| 更新时文件已变化 | 读取报告后在写入前由另一方修改文件 | 未实测 | 未实测 | 是否避免覆盖新内容并报告冲突；无静默丢失 |
| 审批拒绝 | 在需要审批的读取/写入步骤明确拒绝 | 未实测 | 未实测 | 是否停止副作用并如实说明拒绝；无假成功 |
| 用户中止 | 研究或写入过程中发送停止/中止 | 未实测 | 未实测 | 是否保留最后安全版本并说明未完成；无重复发布 |

文件捕获中变化、取消保存回收、拒绝越权读取等已有主机自动化测试；这些测试不代表模型在上述未实测场景会正确运用 Skill。
