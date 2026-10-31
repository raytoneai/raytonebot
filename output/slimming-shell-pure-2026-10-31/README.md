# shell 纯逻辑审计与分项清理（2026-10-31）

基线 `fddcaae`。快速子代理实施，主代理独立 review、验证后逐项提交。第一项提交 `14daa5a`，第二项提交 `e3bd402`。根目录已有未跟踪文件 `c` 保留、不提交。

审计选中群成员等待首个输出的显示投影，以及 Bot 历史名单合并/回退解析。`activeProject`、简单 debug 过滤和零散一行映射保留，避免增加薄包装；prompt 接收判定、submit/follow/queue/reconnect 与副作用保持原位。

## 1. 群聊等待成员首个输出

- 迁入已有 `groupConversationView.ts` 的 `groupTypingMember(conversation, events)`；shell 1,896 → 1,882 行。memo 依赖仍是 `[events, activePiConversationId]`，未改变调用位置。
- [独立 review 脚本](review-group-typing.mjs)比对 Git 基线回调和提取函数体，并将这一处 initializer 排除后比对完整 shell 语法。导入变化人工核对仅为 helper 引入与无用 import 删除；全部状态机代码保持一致。[结果](group-typing-review.json)：6,496 组输入与实际基线表达式结果一致，输入不变。
- 新增 3 项测试覆盖非群、有效/无效成员、null payload、所有 ID 字段、跨成员事件、终态和输入不变。
- `npm run build`、`npm test`（默认并发 653/653，零跳过）、`RAYTONEBOT_URL=http://127.0.0.1:57781 npm run check:local`、`node scripts/cloud-preview.mjs --check` 均通过：[构建](group-typing-build.log)、[测试](group-typing-tests.log)、[本机](group-typing-local.log)、[云入口](group-typing-cloud.log)。
- 真实浏览器在测试结束后独立运行：390 × 844 欢迎页与 19 个事件场景，共 20；文档宽度均为 390，warn/error 为零。[状态](group-typing-ui.json)、[截图](group-typing-ui.png)。

仅使用隔离本机数据和开发场景；未调用真实模型、部署或重建成员并发执行。事件显示验证与真实模型验收分开记录。

## 2. 历史 Bot 名单与成员解析

- 基线 `14daa5a`；提取到已有 `botProfiles.ts` 的 `knownBotsForConversations` 与 `resolveParticipantBot`。shell 1,882 → 1,870 行。当前 Bot 选择、所有调用点和 memo 依赖保持不变，接口只要求实际使用的历史字段。
- Review 要求补上真实的配置/历史同 ID 冲突，以及外观不同的同 preset 配置，避免测试无法分辨取错优先项。新增 3 项测试覆盖顺序、覆盖、回退、输入不变和引用身份。
- [review 脚本](review-bot-resolution.mjs)、[结果](bot-resolution-review.json)：提取函数体相同；排除两个 initializer 后，完整 shell 语法一致。150 组名单合并、4,500 组解析与 Git 基线表达式结果一致。
- 构建、默认并发 656/656 测试（无跳过）、本机接口和云入口检查通过：[构建](bot-resolution-build.log)、[测试](bot-resolution-tests.log)、[本机](bot-resolution-local.log)、[云入口](bot-resolution-cloud.log)。命令同第 1 项。
- [隔离数据脚本](seed-browser-data.mjs)通过现有 store 写入两份合成已完成历史。浏览器验证 Archivist 保留历史名字并继承 planner 头像，当前 Raer 覆盖 Historical Raer；刷新重开及 `@A` 候选为 Archivist。桌面和窄屏正常：[自定义 Bot](bot-resolution-custom.png)、[群聊](bot-resolution-group.png)、[窄屏](bot-resolution-mobile.png)。
- 普通会话入口的 20 个开发场景均通过，390px 无横向溢出，该轮 warn/error 为空：[记录](bot-resolution-ui.json)。

额外路径发现旧缺陷：含历史自定义成员的群聊切换 welcome → Built-in demo，GroupHeader 访问找不到的候选成员而报错。fixture 模式未传 Bot catalog，组件退回内置名单，但仍收到自定义成员 ID。保留[本轮失败](fixture-custom-group-error.json)及[提取前复现](fixture-custom-group-baseline.json)。临时换回 `14daa5a` 的 shell 后复现同一错误，随后按 SHA-256 校验恢复工作源码，并重跑 AST 对照通过。已记入根目录 issue #10；本批没有更改 GroupHeader，也不声称这条路径通过。

两个 review 脚本可传提交号作为目标源码，以便后续改动后复核相应批次；例如 `node output/slimming-shell-pure-2026-10-31/review-group-typing.mjs 14daa5a`。

## 3. shell 注释

- 删除过期的配置器/导出器背景、App.tsx 行号、历史缺陷叙述和重复说明；保留显式空 `previewPrompt`、审批位置、逐事件追加、失败提示和共享布局规则等当前约束。主代理额外删除重复且可能误导的“新会话只清空记录”说明，并修正共享 CSS 规则的描述。
- 仅修改注释；shell 1,870 → 1,839 行，本轮从 1,896 行净减 57 行。[检查脚本](review-comments.mjs)、[结果](comments-review.json)：与 `e3bd402` 的去注释编译输出逐字相同，编译指令未变，无转译诊断。可运行 `node output/slimming-shell-pure-2026-10-31/review-comments.mjs` 复核，也支持传目标提交号。
- 源码事实、文档链接和 `git diff --check` 检查通过。未重复运行前一批的完整测试或浏览器验收。前述自定义群切 fixture 的旧缺陷当时留待单独修复，后续已完成[修复与验收](../issue-10-fixture-group-2026-10-31/README.md)。
