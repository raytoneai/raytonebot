# Jev + Codex 效率说法核验

日期：2026-10-04。结论：**有局部效率收益的公开证据，但“接上 Jev 就能普遍提速省钱”不成立。需要区分证据筛选、运行前选模型，以及额外建立父子 Agent 工作流。**

## 本轮确实验证了什么

- 下载作者公开 benchmark 到 `/tmp/jev-codex-audit.YKkpwG/router-benchmarks`，固定提交 `3af424ba50249646c530d4bd434b7db9b521da9d`。
- 自行写离线复算脚本，按每个 session 的未缓存输入、缓存输入、输出和原实验价格假设重新计费，加入 Jev 用量和所有记录的重试。没有运行原仓库的联网 benchmark。
- 逐一核对 145 份公开主 session JSONL 事件中的输入、缓存输入、输出计数，与结果文件一致。
- 对四组混合实验的 60 个最终只读答案，重新核对 JSON 值、引用和本地 fixture 的对应源码行，全部与记录一致。12 个代码编辑结果沿用作者成绩，未重放补丁测试。
- 子 session 的用量来自作者公开 session 记录，不是我们独立获取的供应商账单。公开文件的一致性不能证明它们没有被作者加工。

复算脚本：[recompute.py](/tmp/jev-codex-audit.YKkpwG/recompute.py)。输出：[recomputed.json](/tmp/jev-codex-audit.YKkpwG/recomputed.json)。临时目录可能被系统清理。

本机 `codex-cli 0.153.4` 已使用 ChatGPT 登录；环境中没有 `TYPESAFE_API_KEY`、`JEV_API_KEY` 或 `OPENROUTER_API_KEY`。因此**本轮尚未重新调用商业 Jev，也未完成本机实时 A/B**。前一轮 Laya 本地试验不能充当 Jev 试验。公开实验的 Codex 版本与指定模型，也不等同于当前桌面任务的所有设置。

## 1. 子 Agent 路由：比较对象决定结论

作者的四组实验是六种合成任务，每组各重复三次，共 72 个逻辑运行；固定子 Agent 组另有一次重试。任务涉及源码定位、日志查找、有限提取、判断、源码研究和代码编辑。下表费用由本轮从用量重新计算；通过率为作者严格检查结果，其中只读部分做了上述复核。

| 工作流 | 通过 | API 等价费用合计 | 单任务耗时中位数 |
| --- | ---: | ---: | ---: |
| 单个 Sol-xhigh Codex | 18/18 | $0.337455 | 17.48 秒 |
| 允许自主委派，实际未建立子 Agent | 18/18 | $0.346462 | 19.25 秒 |
| 主 Agent + 固定 Sol-high 子 Agent | 18/18 | $0.786760 | 36.00 秒 |
| 主 Agent + Jev 路由子 Agent | 18/18 | $0.572820 | 30.10 秒 |

重新计算：Jev 路由子 Agent 比固定子 Agent **便宜 27.2%**；但比单个 Codex 直接做 **贵 69.7%**，中位耗时 **长 72.2%**。因此该数据支持“优化必要的子任务”，不支持“为了省钱先把工作拆给子 Agent”。每类只有一个任务，不能推广到任意复杂项目。

来源：[固定提交的原始 results.json](https://github.com/suenot/codex-jev-router-benchmarks/blob/3af424ba50249646c530d4bd434b7db9b521da9d/benchmarks/mixed-2026-09-26/results.json)、[作者报告](https://github.com/suenot/codex-jev-router-benchmarks/blob/3af424ba50249646c530d4bd434b7db9b521da9d/benchmarks/mixed-2026-09-26/REPORT.md)。

## 2. 在启动 Codex 前选模型：省钱信号真实存在，质量与速度要另看

12 个选定的 Django 只读源码任务，每项两次。Jev 先选模型及推理档位，然后只启动一个 Codex session，避免父 Agent 的额外开销。

| 方案 | 严格通过 | API 等价费用合计 | 总耗时 |
| --- | ---: | ---: | ---: |
| 历史单 Sol-high 对照 | 22/24 | $0.452677 | 735.78 秒 |
| Jev 先选模型，再运行单 Codex | 21/24 | $0.184377 | 775.60 秒 |

复算得到费用 **下降 59.3%**，总耗时 **增加 5.4%**。这是后续运行对比已保存历史结果，非随机交错 A/B；任务也特意选择了适合便宜模型的范围。不能描述为“同质量且更快”。失败包括 JSON 形状和引用不满足契约，因此即使核心事实正确也不能忽略。

同一任务集的父 Agent + Jev 子 Agent方案费用为 $0.657100，比直接做贵 45.2%。早期某些 71%/98% 的节省数字只计算 worker 与 Jev，排除了父 Agent；作者后来已明确说明这一限制。

来源：[原始 direct-root 结果](https://github.com/suenot/codex-jev-router-benchmarks/blob/3af424ba50249646c530d4bd434b7db9b521da9d/benchmarks/django-task-suite-2026-09-26/direct-root-results.json)、[历史对照与父子结果](https://github.com/suenot/codex-jev-router-benchmarks/blob/3af424ba50249646c530d4bd434b7db9b521da9d/benchmarks/django-task-suite-2026-09-26/results.json)、[完整方法及局限](https://github.com/suenot/codex-jev-router-benchmarks/blob/3af424ba50249646c530d4bd434b7db9b521da9d/BENCHMARK.md)。

## 3. 证据筛选：另行核对原始日志

独立审计复算了 108 条公开记录：12 个合成任务、每组三次、三种方案。还核对了发布的十个文件哈希，以及冻结的 runner/task 哈希，均匹配。完整来源、版本和算法见 [证据选择实验审计](./jev-codex-evidence-selection-audit.md)。

实验使用 Codex `gpt-5.6-sol/high`、CLI `0.155.1` 和 Jev `1.13.0`。辅助组通过特制 MCP 工具完成选择和精读，并被限制为两个工具调用；普通组使用 shell 自行搜索。因此它不是“原样加一个 Jev”的对照，也不是本地 CLI 方案的实测。我们可以借鉴先筛选再读取的流程，改用本地 CLI 接口，但其效果需要另测。

| 方案 | Codex 输入 tokens 合计 | 耗时合计 | API 等价费用合计 |
| --- | ---: | ---: | ---: |
| 普通 Codex | 4,643,824 | 1897.673 秒 | $6.200288 |
| 确定性本地筛选 | 2,384,333 | 1351.737 秒 | $3.748537 |
| Jev 证据筛选 | 2,124,397 | 1292.519 秒 | $3.420535 |

按合计值，Jev 相对普通组减少输入 54.25%、耗时 31.89%、费用 44.83%；相对本地筛选的**增量**分别为 10.90%、4.38%、8.75%。普通组到 Jev 的输入缩减中，约 89.7% 已经由确定性筛选方案实现，不能把全部收益都归因于 Jev。

按原预注册的逐任务配对统计方法，输入下降为 39.23%（相对普通组）和 7.89%（相对本地筛选）；它们与合计值的 54.25%/10.90% 不是同一个统计量。日志中 36 条 Jev 路径均记录 `jev-1.13.0` 的一次选择请求；这是作者公开运行记录，并非本轮重新请求模型。

质量解释需要保留历史：原始自动评分使 `confirmedSavings=false`；后续审计发现评分器给任务添加了未明确要求的正数/零值约束，因而修正了结论。对九个被拒答案和评分条件的检查支持这次修正有依据，但这仍是回顾性修正，不能当作事先冻结标准的独立质量等价证明。样例是合成的，普通组与辅助组的规定工具流程也不同。

来源：[固定提交的完整质量更正与效率结果](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/docs/CONFIRMATION-V4-QUALITY-AUDIT-2026-09-20.md)。

## 4. 上下文恢复：并非所有实验都有明显收益

另一个作者的自动恢复实验做了 36 次运行（三组、六任务、两次重复），均通过检查。报告中 Jev 的 Codex tokens 比普通组多 8.2%，中位耗时少 3.6%；后续配对审计认为，没有稳定证据区分费用/速度优劣。任务信息可从持久化工作区恢复，质量又全部满分，所以不能用它证明 Jev 普遍有益或普遍有害。这部分只核查原始报告及更正，未在本机复算 JSON。

来源：[作者报告与解释更正](https://github.com/jcressler/fast-jev-compaction-codex/blob/main/benchmarks/AUTOMATIC-EXPLICIT-RESULTS-2026-09-18.md)。

## 费用口径

本轮使用原实验固定的 API 价格假设，核对算术而非宣称当前实际账单。Codex 输入计数已含缓存输入，计费时分别处理，不能把缓存 token 再加一遍；输出中的推理 token 也不重复另算。父 session、子 session、Jev 和重试都必须纳入。

**API 等价费用减少不等于 ChatGPT/Codex 订阅额度按同百分比减少。** 这些公开记录没有测出本账户的订阅额度节省，也没有证明当前桌面 app 的同等效果。

## 对我们最合理的下一步

先保持同一个 Codex 模型和 effort，比较：原始工具输出、确定性本地筛选、Jev 筛选。任务选择实际会产生大输出的日志定位、代码检索和多文件资料核对，标准答案/行为检查在运行前固定；每组使用同样的工作区快照，交错顺序并重复。记录任务成功、总耗时、输入/缓存/输出、筛选开销、补读和重试。

这可以验证 Jev 的增量价值；若同时换模型、换技能、缩短工具输出，就无法知道收益来自哪一项。先不引入额外父子层，不安装会改全局 Codex 配置的代理。

官方建议使用 `codex exec --json` 保存事件并做确定性行为评分，适合这一验证方式。[OpenAI：Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills)。
