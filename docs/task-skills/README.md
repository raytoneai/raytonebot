# 首批任务 Skills

这两条 Skill 只使用现有的文本 Skills、Bot 分配、联网/文件工具和 `publish_artifact`；不新增 schema、自动导入器、权限或模型设置。

2026-11-01 已通过原服务保存并分配给**本机 Raer**，重新加载后的 `read_skill` 两条均可读取；其他 Bot、模型和权限未变。配置修改前已备份，安装身份及回退文件位置见[本机安装记录](../../output/first-batch-optimizations-2026-11-01/local-skill-install.json)。其他主机仍按以下步骤安装，未同步到云。

## 手工安装与分配

1. 打开 RaytoneBot 的 Settings → **MCP & Skills**，选择 **Add Skill**。
2. 将每个文件的 `name`、`description`、`instructions` 三段分别复制到对应字段，保持 Enabled 后保存。现有校验限制为：name ≤ 80、description ≤ 300、instructions ≤ 16,000 字符；不要粘贴本文件标题或说明。
3. 打开目标 Bot 的 **Edit** → **Engine, model and capabilities** → **Skills**，勾选对应 Skill 并保存。只分配实际要验收的 Bot；Skill 文本不改变该 Bot 的模型、工具或权限。
4. 研究或更新任务的最终交付应是一个 `.md`、`.txt` 或 `.pdf` 文件，并由 Skill 要求用 `publish_artifact({path, preserveVersion: true})` 登记；以工具成功回执为准。

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
