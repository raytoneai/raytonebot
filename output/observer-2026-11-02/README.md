# Observer 本机实施与复核

2026-11-02。起点 HEAD `093309a404b5ec139a0e2b596b665f0389b44a6f`，保留上次未提交的 7 份设计文档。用户授权完成全部本机实现，部署与真实模型评测另算。快速 subagent 分别实现授权/运行层、证据/RSL、原 UI owner；主代理 review、集成与验证。本记录描述提交前的验收快照；实现、文档及证据随本轮统一提交，未 push 或部署。

## 实现范围

- 0a/0b：入口盘点及真实 pending 候选红灯翻绿；一次性主机入口、短期 HttpOnly 会话、CSRF、显式开发者范围、撤销/过期与固定元数据审计。完整路由和历史复现见 [控制面清单](../../docs/product/14-control-plane-inventory.md)。
- 1：主机事实、严格建议类型、版本化引用、私有状态及清单、逐查询预算和拒绝记录、来源世代/删除标记、多源清理与迟到回调阻断。数据满额保留终态/删除空间，可显式清理无建议终态记录。
- 2/3：单次无工具 L1；L2 用实际 Pi SDK 内存会话和固定只读查询，禁用内建工具、个人扩展和上下文发现。模型由用户显式选择，不切换默认或备用模型。
- 4：空闲新增窗口后台、前台取消、重启不补跑；版本绑定审核、单轮限次交接、人工批准的同 Bot/引擎相关经验及复用记录。Observer、后台和 RSL 分别关闭/授权。
- D：原发布包中的实际字节清单、docs、无 Git 验证；私有报告/清单备份和恢复，后台保持关闭。云环境 L2 仍由主机拒绝，未用环境变量宣称验证完成。

## 最终检查

| 检查 | 结果与证据 |
| --- | --- |
| `npm run build` | 通过；[日志](final-build.log)。保留既有大 chunk 提示 |
| `npm test` | **935 项：934 通过、0 失败、1 跳过**；[日志](final-tests.log)。跳过项为本机未安装固定版本 DSH 的图像桥测试 |
| `node scripts/cloud-preview.mjs --check` | 通过；[日志](final-cloud-check.log)，包括云认证、Host/Origin、可信上下文、handoff 与脱敏诊断 |
| 隔离主机 `scripts/check-local.mjs --session-file <临时0600文件>` | 通过 UI、Pi SDK、12 工具、空 prompt 400、跨源 403；无模型请求。临时凭据随目录销毁；[结果](auth-ui-results.json) |
| Python AgentSphere 全套 | **30 项：27 通过、3 Linux 专用项跳过**；[日志](python-tests.log)。包含发布 13、备份恢复 8；本机 macOS 不冒充 Linux subreaper/UID 验证 |
| Python VPS 更新 | **4/4**，包含解包拒绝、忙碌拒绝和失败回滚；未连接 VPS |
| 本机实际发布包 | AgentMatrix/AgentSphere 均成功解包核对，约 9 MB，AgentMatrix 小于 20 MiB；无 `.git` 默认识别，改字节后拒绝。完整 hash/大小见 [结果](package-results.json)、[AgentMatrix 清单](agentmatrix-manifest.json)、[AgentSphere 清单](agentsphere-manifest.json) |
| 文档新增链接/锚点、空白 | [检查结果](link-results.json)；`git diff --check` 通过 |

实际包验证使用 OS 临时 Git index 让新增源码进入候选包，真实用户 index 前后哈希一致；临时包和解包目录已销毁。清单来自实际归档字节，含 dist、代码、测试、文档，不把自身参与哈希。此步骤没有发布。

## 实际浏览器与 SDK

[Observer 浏览器脚本](check-observer-ui.mjs) 启动真实隔离 Vite/HTTP/存储，运行受控 L1/L2：显式模型及启用、公开源码取证、报告进入原聊天、刷新后点历史恢复且不重跑、审核 revision、清理无建议记录且保留 finding、临时只读证据、创建普通 Bot 交接草稿但不发送、390px 和撤销后私有内容清空/HTTP 403。检查原始源码标记不落盘、Observer 草稿不进浏览器持久存储；[结果](observer-ui-results.json)。

[授权浏览器脚本](check-auth-ui.mjs) 验证匿名设置可达、主机 fragment 被清除、中文/英文/日文 × 桌面1280/窄屏390 的授予/读取/撤销；普通 Bot API 仍可访问，页面无错误或横向溢出。[40 场景脚本](fixture-browser-check.mjs) 逐一打开 welcome + 19 事件流 × 两尺寸，全部通过；[结果](fixture-results.json)。键盘提交使用 Enter，既有 Output 键盘/表单回归包含在全量测试。

主代理实看截图：[聊天](observer-chat-desktop.png)、[审核](observer-review-desktop.png)、[证据](observer-evidence-desktop.png)、[390px 设置](observer-review-mobile.png)。三语设置、平台门和迟到响应的受控浏览器回归在 `observerUi.test.ts`。

`observerRuntime.test.ts` 使用真实安装的 Pi SDK 与 localhost 脚本端点，验证 query 工具清单、两次请求、每次实际 `max_completion_tokens=2000`、无个人 AGENTS/extensions 加载、内存会话与无原始查询持久化。`observerControlBaseline.test.ts` 经真实 Pi auto Bash → curl → HTTP 得到 401，真实模型租约也不能自批；匿名/伪造请求的候选及 revision 不变，有效 developer + CSRF 审核才持久成功。[最终基线结果](control-baseline-final.log)。这些都是受控模型协议测试，不是外部模型能力评测。

## 独立 Review

### Standards

两条发现均修复并由原 reviewer 复验：准备阶段 `refresh()` 等待期间撤销授权后不得启动/保存（模型调用0、登记运行0，撤销再授予也不能复活旧 proof）；Observer 存储损坏不再阻断开发者的普通历史（普通历史200、Observer503）。主机 proof 用弱引用绑定 session/developer revision，准备上下文有界且请求结束释放。

### Spec

三条发现均修复并由原 reviewer 复验：多源 RSL 依赖存全 scope，删除第二来源也清候选正文及复用记录；日志/统计/config/usage 变化在审核、交接和经验注入前重新检查；拒绝查询保存固定原因码/关联 ID、预扣查询预算，不保存原始参数。并发附验确认拒绝另一查询不会清掉已在途的 reservation。

主代理另修/要求修复：匿名设置入口、fixture 错误写配置、Observer 重连游标及丢失回执、模型可用性错误回退、报告刷新产物、来源/日志版本、私有 manifest 清理、全状态容量与加载上限、no-Git 默认发现、前台/后台取消语义和群公开终态触发。所有修改进入最终组合检查。

历史失败包括：0a 未授权审核真实红灯；迭代中的并发 reservation、取消测试时序、关闭功能的旧 gate 测试，以及候选新增 revision 后的旧期望。根因与断言均已修正；最终通过不替代这些历史事实。早期 0b 的 [892 项回归](0b-tests.log) 仅为阶段记录，最终采用上表结果。

## 未验边界

未调用真实模型、启用用户实际后台、修改用户模型/数据，未部署 AgentSphere、AgentMatrix 或 VPS。真实模型解释质量、注入抵抗与新会话收益对照，以及每个平台的 UID/网络、实际安装版本、更新/回滚/恢复，仍见 [OB-04/07/09](../../docs/product/08-acceptance.md#observer-acceptance)。本机同 UID 不是硬隔离；源删除不承诺擦除已注入原生上下文、旧离线备份或模型服务留存。源代码秘密检测有界，不能作为通用 DLP。
