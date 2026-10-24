# 2026-10-24 审查修复验收

修复范围：console 撤销与设置并发覆盖、Provider 保存期间启动任务的竞态、Composer 跨服务选模型的双重提交。没有改变默认模型、菜单可见性、slot registry 或 vendor。

## 回归证据

- `control/consoleKeys.test.ts`：请求在读取旧记录后和原子写入前暂停，随后管理员撤销；claim/settings 均返回 401，原会话失效且不入队。另验两个并发 claim 只创建一次、正常设置保留 claimedAt。修复前旧请求返回 201/200，覆盖撤销状态。
- `src/pi/providerStore.test.ts`：请求体挂起时启动真实 controller 的测试 bridge 轮次；保存返回 409，revision 不变，bridge 不被 dispose。修复前保存返回 200 并销毁运行中的 bridge。
- [模型菜单浏览器回归](provider-selection.mjs)：隔离 host 保存配置，浏览器临时启用当前默认隐藏的可选菜单，拦截 `/config` 避免真实模型会话。修复前跨服务选择得到 `[200,409]` 且目标模型错误；修复后只有一次 200，目标模型正确、旧服务模型不变，刷新保留；同服务切换成功，409 失败保持原选择并显示错误。见 [日志](provider-selection.log) 和 [截图](provider-selection.png)。
- [20 个内置场景](fixtures.json)：通过 `?devtools=1` 的原 picker 逐一切换，无 pageerror 或页面横向溢出；相关脚本 [fixtures.mjs](fixtures.mjs)。

## 检查结果与边界

- `npm run build` 通过（保留现有大 chunk 提示）。
- `npm test` 469/469 通过，见 [日志](tests.log)。
- `npm run check:local` 通过：UI、SDK、12 个工具、空输入校验、跨源拒绝；未调用模型。
- `node scripts/cloud-preview.mjs --check` 通过。
- 修改涉及的源码及文档 `git diff --check` 通过；工作树原有 tmp/avatar-eye-study 尾随空格未纳入本次修复。
- 浏览器和 host 使用独立临时数据/工作目录，不读取或修改用户凭据。Redis 原子操作使用现有 Redis REST 通道的 EVAL；并发测试使用内存存储，未连接线上 Redis/Upstash。未部署或推送。
