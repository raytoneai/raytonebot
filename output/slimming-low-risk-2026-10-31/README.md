# 第二轮：剩余低风险纯逻辑（2026-10-31）

基线 `2432baa`，接续[大模块审计](../slimming-pure-modules-2026-10-31/README.md)。快速子代理逐项实现，主代理 review、验证后分别提交；根目录既有未跟踪文件 `c` 保留。会话、流式 translator、路由生命周期和组件分组/交互不迁移。

## 1. HTTP 输入解析

- 提交 `4076487`（`Extract HTTP input parsing`）。
- 五个纯 helper 迁入 `src/pi/piHttpInput.ts`（60 行），`piHttpHost.ts` 746 → 689 行。路由和 JSON/响应/heartbeat 留原处，字段筛选、数值范围、delta clamp、默认权限和审批值均不变。
- 修正“只允许已知字段”和“其他输入一律拒绝”的模糊说明：嵌套渠道字段保留合法字符串值，名称不在此白名单过滤；浏览器解析只投影支持字段，非法必填值返回 undefined。
- 主代理运行[声明对照脚本](review-moved.mjs)，五函数与基线语法一致，其余完整 HTTP host 语法一致：[结果](http-review.json)。
- 新增 4 项边界测试；实现代理的输入/主机/渠道/桥接窄回归 62/62、静态检查通过。主代理[构建](http-build.log)、[完整测试](http-tests.log) 667/667（无跳过）、[本机](http-local.log)和[云入口](http-cloud.log)检查通过。未改变 UI，未单独重复视觉回归。

## 2. CLI 工具规范化

- 提交 `b088ced`（`Extract CLI tool normalization`）。
- 工具映射、参数/输出规范化和共享值解析迁入 `cliToolNormalization.ts`（92 行），`cliStreams.ts` 426 → 329 行。新模块不依赖 translator；原 `normalizeClaudeTool`、`displayCommand`、`NormalizedTool` 入口保留。
- 主代理核对 8 个迁出声明与其余 9 个声明的完整语法一致，两种 translator 的状态、emit 顺序及事件构造均未改：[对照](cli-review.json)。旧公开函数与新模块实现为同一引用：[导出兼容](cli-exports.json)。
- 压缩文件头背景叙述，纠正“只有纯函数”并保留 CLI capture 日期/版本；合并重复 host 工具名称说明。新增 3 项测试覆盖 Codex 文件变更/空或坏条目、命令、MCP error 优先级与 JSON 输出、输入不变；原 Claude/Codex capture 及别名回归 31/31 通过，review 补断言后定向 3/3 通过。
- 主代理[构建](cli-build.log)、[完整测试](cli-tests.log) 670/670（无跳过）、[本机](cli-local.log)和[云入口](cli-cloud.log)检查通过。未改变事件映射语义；浏览器场景在下面 ChatFrame 批次统一验证，未重跑真实 CLI/模型。

## 3. 聊天条目投影

- `ConversationEntry` 和 `buildConversationEntries` 迁入 `src/runtime/conversationEntries.ts`（37 行），`ChatFrame.tsx` 587 → 542 行。按项目约定把纯逻辑放在 runtime；原提示词 filter、分组/头像 lane、滚动、hooks 与 JSX 保留。
- 主代理核对两项迁出声明及其余 16 个声明的完整语法与基线一致：[对照](chat-review.json)。精简审批导出/overlay 的旧编辑器历史叙述，保留兼容入口、默认位置与 replayIdentity 包装约束。
- 新增 3 项行为测试覆盖混合条目顺序/引用、助手消息索引、空/短/长 history、空字符串占位及 preview 原文/空白/空 timeline。连同原消息复制 SSR 回归 4/4 通过；review 纠正空 timeline 测试标题并补充断言后，定向 3/3 通过。
- 主代理[构建](chat-build.log)、[完整测试](chat-tests.log) 673/673（无跳过）、[本机](chat-local.log)及[云入口](chat-cloud.log)检查通过。构建保留既有配置加载和大 chunk 提示。
- 实际浏览器验证桌面 Group chat 作者与消息顺序：[截图](group-chat.png)。390×844 逐项检查欢迎页和全部 19 个事件场景，内容可见且无横向溢出，控制台 warn/error 为零：[场景记录](chat-ui.json)。测试页已关闭、视口已恢复；这不是对真实模型运行的替代验收。

本次三个主要模块共减少 199 行；计入三个新纯模块后，产品源码合计净减 10 行。上轮列出的三项低风险候选已完成，会话和流式状态机未动。

本轮只做隔离本机验证，未调用真实模型、推送或部署。
