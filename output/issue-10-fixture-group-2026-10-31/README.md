# issue #10：历史自定义群切换开发场景（2026-10-31）

基线 `21a5f07`。快速子代理实现与定向测试，主代理 review、浏览器回归及提交。原有未跟踪文件 `c` 保留。

## 复现与修复

使用[隔离数据脚本](seed-history.mjs)生成历史群：Archivist 在首位，Raer 为第二位群主。打开 Historical group → 欢迎页 → Built-in demo，基线的 GroupHeader 因缺失成员的 `.presetId` 访问崩溃：[状态与控制台](before.json)、[截图](before.png)。首次打开隔离站点曾空白且无控制台错误，重载后正常进入并复现；没有将该次空白计作成功验收。

原因是 fixture 模式省略 Bot catalog，却继续把历史群成员传给群聊头部。修复在非空 `streamId` 下省略六个 live 展示字段，让现有组件使用默认场景展示；不拼造 fixture 成员，也不把历史 Bot 配置传入 fixture。GroupHeader/GroupWelcome 遇到 catalog 缺失的成员时，名称回退 ID，头像仅使用查到的成员。

主代理核对六个字段的 live 表达式与基线逐字一致，其余 shell 语法一致，会话/流式状态机未改：[review 脚本](review-shell.mjs)、[结果](shell-review.json)。`NewChatMenu` 的查找来源于同一 candidates 列表，无缺失来源，保持原样。

## 验证

- 新增组件 SSR 回归：未知历史 ID 保留已知名字、历史 catalog 名称优先、第二位实际群主禁用、空 catalog 和全未知成员。基线两项因相同 `.presetId` 错误失败；修复后 3/3 通过：[失败日志](regression-before.log)、[通过日志](regression-after.log)。主代理要求把按钮断言限制在单个节点，避免正则跨按钮导致假阳性。
- `npm run build` 通过，仅既有大 chunk/配置加载提示：[构建日志](build.log)。
- `npm test` 默认并发 659/659 通过、零跳过：[完整日志](tests.log)。浏览器操作与完整测试分开执行。
- 收紧测试类型后，首次静态检查发现 Provider 必填 `children` 未作为 prop 传入：[失败日志](typecheck.log)。改正测试辅助函数后，`tsc --noEmit` 退出 0、无诊断（[日志](typecheck-after.log)），3 项定向测试再次通过；产品源码未再改动。
- `RAYTONEBOT_URL=http://127.0.0.1:52647 npm run check:local`、`node scripts/cloud-preview.mjs --check` 通过：[本机](local.log)、[云入口](cloud.log)。
- 实际浏览器重新走原崩溃路径，正常显示 Built-in demo；Group chat 场景保留 Raer、Tonny、Bob 作者标签。返回历史群后，Archivist 名称、`@A` 候选与第二位群主禁用状态保持；刷新后重新打开历史群正常。
- 从历史群进入欢迎页及全部 19 个事件场景，共 20 项；390px 均无横向溢出，事件场景不包含历史消息/成员头部，控制台 warn/error 为零。[完整记录](ui.json)、[桌面](after-desktop.png)、[窄屏](after-mobile.png)、[群聊场景](group-fixture.png)。

仅本机隔离数据与真实应用组件验证。未调用真实模型、发送消息、部署或推送；未修改用户原有配置。
