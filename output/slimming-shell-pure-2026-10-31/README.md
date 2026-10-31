# shell 纯逻辑审计与分项清理（2026-10-31）

基线 `fddcaae`。快速子代理实施，主代理独立 review、验证后逐项提交。根目录已有未跟踪文件 `c` 保留、不提交。

审计选中群成员等待首个输出的显示投影，以及 Bot 历史名单合并/回退解析。`activeProject`、简单 debug 过滤和零散一行映射保留，避免增加薄包装；prompt 接收判定、submit/follow/queue/reconnect 与副作用保持原位。

## 1. 群聊等待成员首个输出

- 迁入已有 `groupConversationView.ts` 的 `groupTypingMember(conversation, events)`；shell 1,896 → 1,882 行。memo 依赖仍是 `[events, activePiConversationId]`，未改变调用位置。
- [独立 review 脚本](review-group-typing.mjs)比对 Git 基线回调和提取函数体，并将这一处 initializer 排除后比对完整 shell 语法。导入变化人工核对仅为 helper 引入与无用 import 删除；全部状态机代码保持一致。[结果](group-typing-review.json)：6,496 组输入与实际基线表达式结果一致，输入不变。
- 新增 3 项测试覆盖非群、有效/无效成员、null payload、所有 ID 字段、跨成员事件、终态和输入不变。
- `npm run build`、`npm test`（默认并发 653/653，零跳过）、`RAYTONEBOT_URL=http://127.0.0.1:57781 npm run check:local`、`node scripts/cloud-preview.mjs --check` 均通过：[构建](group-typing-build.log)、[测试](group-typing-tests.log)、[本机](group-typing-local.log)、[云入口](group-typing-cloud.log)。
- 真实浏览器在测试结束后独立运行：390 × 844 欢迎页与 19 个事件场景，共 20；文档宽度均为 390，warn/error 为零。[状态](group-typing-ui.json)、[截图](group-typing-ui.png)。

仅使用隔离本机数据和开发场景；未调用真实模型、部署或重建成员并发执行。事件显示验证与真实模型验收分开记录。
