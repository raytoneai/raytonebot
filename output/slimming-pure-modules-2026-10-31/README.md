# 第二轮：剩余大模块审计与纯逻辑提取（2026-10-31）

基线 `f7793f7`。两位快速子代理分别只读审计前端和服务端，快速实现代理按项修改，主代理 review、验证后逐项提交。原有未跟踪文件 `c` 保留。

## 审计结论

行数用于定位，职责与依赖决定是否拆分；不将文案、图标和测试用例数等同于维护风险。下表是本轮开始时的物理行数，测试文件未纳入排行。

| 模块 | 行数 | 本轮判断 |
| --- | ---: | --- |
| `styles/app.css` | 9,624 | 上轮已按引用和级联顺序清理；本轮不重排样式。 |
| `agent-shell.tsx` | 1,839 | 剩余主体是状态、effect、提交/恢复/队列；不继续拆状态机。 |
| `agentmatrix/icons.tsx` | 1,366 | 图标定义为主，按行数拆分收益低。 |
| `pi/piRuntimeController.ts` | 1,196 | 运行、会话、审批和生命周期耦合，保留。 |
| `i18n/copy/features.ts` / `settings.ts` | 1,109 / 776 | 多语言文案数据，非巨型行为模块。 |
| `ComposerFrame.tsx` | 889 | 草稿、FileReader/URL 与控件生命周期耦合；不改布局或新增组件。 |
| `pi/browser/browserWorker.ts` | 888 | CDP/Playwright、下载归属、快照及 Vault 协议；纯片段过小，不拆。 |
| `harness/adapters/piAdapter.ts` | 808 | 有状态事件翻译；少量文本辅助函数的迁移收益不足。 |
| `pi/piHttpHost.ts` | 746 | 路由接线保留；输入白名单解析约 50 行可作后续候选。 |
| `schema/agentuxConfig.ts` | 705 | 类型、默认项目和 Provider 数据为主，暂不增加类型依赖。 |
| `pi/groupChat.ts` | 701 | 上轮已抽规则和提示词；剩余群执行状态机保留。 |
| `SessionSidebar.tsx` | 624 | 重命名/删除、焦点、虚拟窗口与回调关联，保留。 |
| `pi/cliHarness.ts` | 616 | 选中 CLI 参数与环境变量构造；进程、审批、续接留原处。 |
| `ChatFrame.tsx` | 587 | 约 39 行消息条目投影可后续提取；分组 lane/live 状态保留。 |
| `ToolCallCard.tsx` | 556 | 选中文件引用与预览文本纯解析；React 状态与渲染保留。 |
| `runtime/eventNormalizer.ts` | 514 | 工具词汇与标题解析可进一步归拢；本轮先处理职责更清楚的两项。 |
| `pi/cliStreams.ts` | 426 | 工具规范化约 100 行可后续提取；两个流式 translator 不动。 |

## 1. CLI 配置构造

- `cliHarness.ts` 616 → 462 行，配置模块 `cliHarnessConfig.ts` 162 行。迁出五个配置函数及专属常量；原公开入口重导出兼容。默认 `process.env` / `homedir()` 保留，环境变量函数只修改新建副本。
- 来源说明集中在配置模块；纠正“只含 web 工具”的旧说明，保留审批 ask 规则、凭据替换、子命令隔离和后台任务生命周期约束。
- 主代理[review 脚本](review-cli.mjs)核对 11 个声明、其余完整 harness 语法和原公开导出；397 组显式参数/env 结果与 Git 基线一致，输入不变：[结果](cli-review.json)。未改运行/审批/会话代码。
- 实现代理跑现有 CLI、MCP、工作目录窄回归 22/22 及静态检查通过；原测试已覆盖该配置契约，没有新增重复测试。
- 主代理验证：`npm run build`、`npm test` 默认并发 659/659（无跳过）、`RAYTONEBOT_URL=http://127.0.0.1:60858 npm run check:local`、`node scripts/cloud-preview.mjs --check` 通过。[构建](cli-build.log)、[完整测试](cli-tests.log)、[本机](cli-local.log)、[云入口](cli-cloud.log)。构建仅原有大 chunk/配置加载提示。

本轮只做隔离本机验证，不调用真实模型或部署。CLI 配置提取不涉及组件/事件映射，无需单独重复开发场景视觉验收。
