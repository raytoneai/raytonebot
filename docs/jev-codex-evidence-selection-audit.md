# Jev + Codex 证据筛选效率复核

审计日期：2026-10-04。结论：**公开逐次记录支持这组人工调查任务的效率收益，但大部分收益来自有界证据工具本身；Jev 相对于同样工具的本地确定性选择器，增益明显更小。** 质量修正有来源依据，仍是事后修正，不能宣称普遍无损。

审计对象：[jcressler/jev-codex-token-saver](https://github.com/jcressler/jev-codex-token-saver)。固定读取提交 `1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820`；实验冻结提交为 `c593e3dcc9fb0ff2c84bd4b5e7c3c0b963b5e8bb`。下载和独立 Python 复算产物位于 `/tmp/jev-codex-audit-23tmlh75/`，结果为 [recomputed.json](/tmp/jev-codex-audit-23tmlh75/recomputed.json)。未安装依赖、未运行仓库脚本、未调用 Codex 或 Jev、未传送私有资料。

## 实验到底比较什么

- 模型为 **Codex `gpt-5.6-sol` / `high`**，CLI `0.155.1`；Jev `jev-1.13.0`。
- 12 个合成任务，分为日志定位、仓库定位、失败测试、代码/配置/文档混合各 3 个；每任务每组重复 3 次，共 108 次，每组 36 次。每任务组内顺序轮换。
- Stock 用普通 shell 搜索和有界读取；Local 与 Jev 则被明确要求只能调用特制 MCP 工具，按给定参数做一次选择、再精读一次，共恰好两个工具调用。两辅助组候选和返回上限一致；Local 无 Jev key，Jev 组要求真实选择请求。
- 因此 Stock 对照同时改变了搜索流程和工具能力；Local 对照更能分离 Jev 的附加价值。这测的是只读调查回答，不是编码、修复提交或通用 Agent 工作效率。

来源：[冻结 manifest](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/results/confirmation-v4-2026-09-20/manifest.json)、[执行器 promptFor / codexArgs](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/confirmation-v4.mjs#L73)。

## 从逐次记录独立重算

本轮读取 `summary.json.results` 的 108 条记录重新分组求和，并用原协议的统计定义独立实现 Python 计算；没有直接复制作者汇总栏。所有 12×3 个任务/组组合均有三条记录，108 条均标记 valid。下载的 10 份公开数据文件 SHA-256 全部符合 `artifact-hashes.json`；当前读取的 runner 和任务定义字节也符合冻结 manifest 的散列。

| 每组 36 次合计 | Stock Codex | 本地确定性选择 | Jev 选择 |
|---|---:|---:|---:|
| Codex 输入 tokens | 4,643,824 | 2,384,333 | 2,124,397 |
| 其中缓存输入 | 3,815,680 | 1,877,632 | 1,668,864 |
| Codex 输出 tokens | 68,072 | 48,534 | 45,850 |
| 工具调用 | 185 | 72 | 72 |
| 累计时间，秒 | 1,897.673 | 1,351.737 | 1,292.519 |
| 合并 API 等价成本，美元 | 6.200288 | 3.748537 | 3.420535 |

Jev 相对 Stock：累计输入 **−54.25%**，时间 **−31.89%**，合并成本 **−44.83%**。相对本地选择：累计输入 **−10.90%**，时间 **−4.38%**，成本 **−8.75%**。按累计输入差额描述，Local 已取得 Stock→Jev 总节省量的 **89.68%**；不能把全部节省归于判断模型。

协议主要统计量是：先对每个任务取三次输入中位数，再对 12 个配对比值取几何平均。独立复算结果与作者精确一致：Jev 对 Stock 节省 **39.228%**，任务级 10,000 次 bootstrap 95% 区间 **19.366%–56.202%**；对 Local 节省 **7.891%**，区间 **4.053%–12.039%**。它与累计百分比衡量不同，不能混用；“至少节省 20%”的预设强结论未过，因为区间下界低于 20%。

成本按冻结价格重算：Codex 未缓存输入/缓存输入/输出每百万分别 $4/$0.4/$20；Jev 输入每百万 $0.042、输出 $0。36 次 Jev 输入 329,949、输出 50,544，附加 $0.013858 已计入合并值。这是约定价格的估算，非用户订阅实际账单。

来源：[公开逐次结果](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/results/confirmation-v4-2026-09-20/summary.json)、[散列清单](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/results/confirmation-v4-2026-09-20/artifact-hashes.json)、[统计代码](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/confirmation-v4.mjs#L399)。

## 质量结果为何改了

1. 原自动正则判分是 Stock **24/36**、Local **23/36**、Jev **22/36**，故原始 `summary.json.primary.confirmedSavings` 和 `correctnessNoRegression` 均为 **false**，不是一次按原判分规则全数通过的确认实验。
2. 在第一批完成后、第二三批之前才冻结语义 rubric。原语义共识为 Stock **34/36**、Local **32/36**、Jev **33/36**；两评审同意 107/108，另一次由第三评审裁决。这是作者保留的盲评记录，本轮没有重新做全套盲评。
3. 后来的[质量审计](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/docs/CONFIRMATION-V4-QUALITY-AUDIT-2026-09-20.md)认为九次失败来自额外要求“配置必须大于零”和“必须测零值与正值”。本轮独立检查了全部九个受罚答案、任务定义、日志生成器和语义 rubric，认可这一具体纠正：日志只说配置无效，没有验证器、合法范围或零值定义；原任务仅要求有界修正和回归检查。九个答案都定位正确并给出相关修正/检查，八个明确包含合法值成功用例，另一个 Stock 答案只测非法值也满足原始通用要求。

因此把这些新增惩罚去掉后，**三组均 36/36 是合理的事后解释**，但不能改称实验前就固定了此标准，也不能据此证明任意任务质量不下降。原文件仍保留失败标记是正常的历史记录，不是复算发现数据篡改。

来源：[任务定义与日志生成器](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/confirmation-v4-tasks.mjs)、[后来添加的语义 rubric](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/confirmation-v4-semantic-review.mjs#L14)、[原共识与逐条判分](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/benchmarks/results/confirmation-v4-2026-09-20/semantic-consensus.json)。

## 是不是真实模型、能否外推

记录包含 Codex 进程起止、usage、答案，以及每次 Jev 的模型、概率、延迟和 token usage。36 个 Jev 记录全部为 `mode=jev`、`jevRequests=1`、`model=jev-1.13.0`，没有标作 bypass 或 local-fallback；这与执行器的真实 API 校验一致。**可确认公开记录在内部一致地描述了实调用；本轮没有重新向服务商核验，更没有自己复跑。** 仓库公开的是汇总文件内逐次结果与选择遥测，不应称作本轮审查了全部原始 Codex stdout/HTTP 流量。

证据强度限制包括：12 个合成任务并非 108 个独立真实项目；辅助组固定工具参数而 Stock 自行搜索；题目和工具围绕长日志/大量噪声设计；语义标准晚于第一批且最终解释又经事后纠正。作者还说明现发布版本增加恢复选择逻辑，而 v4 数字属于增加该行为前的版本。[最终报告](https://github.com/jcressler/jev-codex-token-saver/blob/1e1214bd7a1d7b2d3ee32bf1b8a88bbf9cd9d820/docs/CONFIRMATION-V4-FINAL-2026-09-20.md)

实际可借鉴的是“先本地检索和裁剪，再可选地让 Jev 重排少量候选”；在本项目评估时应同时保留原生、本地确定性、Jev 三组，并在真实任务上预先固定质量标准。
