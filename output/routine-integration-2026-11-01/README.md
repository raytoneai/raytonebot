# Routines 移植验收 — 2026-11-01

基线 `3a78cef`；仅移植 `e4c795f6d8bbe0ca02f27c4604e760913fb24205`，未合并其父分支的重复功能提交。快速 subagent 执行，主代理 review 和验证后提交。

## Review 与冲突处理

- `routines.ts` 与原 `RoutinesSection.tsx` 的生产修改和源提交完全一致；保留 main 当前 controller、退出清理、问答计时、运行所有权、设置并发与键盘修复。
- 核对准备阶段撤销信号和当前 runPrompt 接受边界；已接受运行不被停用中止，旧请求身份不能影响新启动。恢复只采用准确 runId 的持久化真实终态；保存失败可重试，不重放模型任务。计时候选下界和 occurrence 防重保留。
- 路线图、验收文档保留 main 原有记录，并将源分支验证明确标为历史；ADR-058 无编号冲突。main 已删除的 isolated-first-batch-push README 保持删除，失效引用已移除。源分支原始证据见[历史记录](../routine-reliability-2026-11-01/README.md)。

## 本次实际验证

- Subagent 定向回归：`node --test src/pi/routines.test.ts src/pi/routineClockBoundary.test.ts src/pi/routineLifecycle.test.ts src/runtime/routineControls.browser.test.ts`，33/33 通过，无跳过。
- `npm run build`：TypeScript 与 Vite 构建通过，保留既有大 chunk 提示。[日志](build.log)
- `caffeinate -i npm test`：831 项，830 通过、1 项缺少指定 DSH 环境跳过、0 失败。[日志](test.log)
- 隔离临时主机运行 `scripts/check-local.mjs`：UI、Pi SDK、12 工具、空请求及跨源拒绝通过，无模型请求。[日志](check-local.log)
- `node scripts/cloud-preview.mjs --check`：入口鉴权、host/origin、CSRF、handoff 与诊断边界通过。[日志](cloud-check.log)
- 复用已有 `check-fixtures.mjs`，桌面 1280px / 窄屏 390px 各 20 场景，40/40 通过，无页面错误或横向溢出。[回执](visual/fixture-results.json)、[日志](fixtures.log)
- 复用 routine 浏览器测试，临时副本只改截图目标，四种结果入口状态通过，执行后删除副本。主代理目视[首次失败](visual/routine-failed-mobile.png)与[历史结果可打开](visual/routine-recovered-mobile.png)；[日志](routine-ui.log)。未覆盖完整读屏或其他浏览器。
- 相对文件链接、无冲突标记、`git diff --check` 通过。日志只规范化尾随空格和空白尾行，不更改检查结果。

测试使用临时数据、受控时间和受控引擎，不改用户任务、模型、权限或 stash；未调用真实模型、部署或验证云端休眠唤醒。防睡眠仅持续到验证命令结束，临时服务和测试文件均已清理。
