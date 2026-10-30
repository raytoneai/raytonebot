# 审批直接操作 · 2026-10-31

工具审批改为三个直接动作：允许一次、始终允许、拒绝。点击即提交，无默认选择和第二个确认按钮。主机权限范围、审批等待和回执核对保持原行为。

## 参考与取舍

- [VS Code 工具审批](https://code.visualstudio.com/docs/agents/run/approvals)：先查看工具和参数，再允许一次或指定授权范围；[工具使用说明](https://code.visualstudio.com/docs/agents/run/tools)明确点击 Allow 执行。
- [Claude in Chrome 权限指南](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)：直接选择一次允许、站点长期允许或拒绝，长期授权仍有需单独询问的敏感操作。
- 本项目采用直接动作并明确自身已有范围：此 Agent 的该工具，受保护操作仍询问；没有引入其他产品的站点/工作区权限模型。
- 键盘沿用原生按钮：Tab 移动焦点，Enter/空格执行。提交锁同步生效，连点不同动作仍只接受第一个。持续授权说明在窄屏换行完整显示。
- `InlineApprovalPrompt` 仍供问答、账号选择和渠道设置复用；这些表单保留自己的提交按钮。

## 验证

- `node --test src/runtime/approvalSubmission.browser.test.ts`：11/11，见 [定向日志](targeted-tests.log)。先修改原测试确认旧实现因确认按钮和 radio 残留失败，再完成实现。
- Chromium + 生产 React 组件 + piClient 覆盖中英日两种表面、同步连点、丢失回执状态核对、刷新取消，以及所有三种动作的点击/键盘提交。移动焦点不发送请求；共用表单选择不自动提交。
- `npm test`：642/642，无失败或跳过，见 [完整日志](tests.log)。
- `npm run build` 通过，仅既有大 chunk 提示，见 [构建日志](build.log)。
- 隔离数据启动 5195 服务，`RAYTONEBOT_URL=http://127.0.0.1:5195 npm run check:local` 和 `node scripts/cloud-preview.mjs --check` 通过，见 [本机检查](local-check.log)、[云入口检查](cloud-check.log)。
- IAB 390×844 日文界面走查全部 20 个内置事件场景，横向溢出与浏览器 error 均为 0，见 [逐项记录](fixtures.json)。
- 已实看 [完整应用](app-approval-ja-mobile.png)、[内嵌审批](inline-waiting.png)、[外部审批](external-waiting.png)。

## 边界

使用受控网络响应和演示事件；未调用真实模型、提交、推送或部署。主机崩溃恢复和真实模型长时间挂起未新增验证。本记录取代前一日 UI 的二次确认步骤。
