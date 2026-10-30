# 分批瘦身验收 · 2026-10-31

## 第一批：无引用旧代码

基线 `7d54945`。实施由 gpt-6-luna 子代理完成，主代理独立审查引用链、barrel、依赖锁和文档后提交。净删约 7,000 行旧源码/文案/样式及锁条目；主要收益是减少维护噪音，不以此推断启动性能提升。

- `npm run build` 通过（原有 chunk size/Vite native config 提示保留）。
- `npm test`：642/642，通过，无跳过。
- `RAYTONEBOT_URL=http://127.0.0.1:5196 npm run check:local`：UI、Pi SDK、12 tools、空 prompt 与跨源拒绝通过。
- `node scripts/cloud-preview.mjs --check`、`git diff --check` 通过。
- 隔离临时数据/工作区，IAB 390 × 844 欢迎页及 19 个事件场景通过；[结果](cleanup-fixtures.json)，[截图](cleanup-fixture.png)。

保留 `vendor/`、穷举 slot registry、ExportFrame/scaffoldManifest stub、GitPreviewState 类型入口、Pi 事件适配和所有开发场景。修正架构文档中旧视图模型仍在使用的过时说明。未调用真实模型，未部署或推送。

## 第二批：Settings 分区

基线 `9def198`。SettingsDialog 从 1,362 行降至 212 行；各分区仍位于原 owner 目录，最大分区约 250 行。主代理 review 修正多余导出、未使用声明和常量归属，收窄分区 props；24 个迁出函数主体与基线一致。Provider editor/关闭拦截、routineDrafts、routine/memory keys 与 Vault open-only 挂载不变。

- 构建通过；完整测试 642/642；TypeScript 检查所有 settings 模块无未使用声明；diff 检查通过。
- 桌面实测模型 Base URL 临时草稿在分区切换后保留；关闭出现拦截，继续编辑、放弃恢复原值。没有保存 Provider 配置或调用模型。
- 390px 全部分区与 20 个场景通过；[UI 记录](settings-ui.json)、[拆分后截图](settings-after.png)。模块移动期间出现过 HMR 导出错误，最终代码重新加载后的 error 为 0。
- 例行任务草稿跨分区存续由函数主体与 owner 状态位置的对比确认；本次没有新增真实计划任务或验证外部 IM/MCP/Vault 服务。

## 第三批：Pi SDK 桥接

基线 `d270484`。`piHost.ts` 2,246 → 1,928 行，新增 `piSdkBridge.ts` 340 行。原 20 个顶层函数主体经 AST 逐一比较一致；原公开 `PiSessionBridge` / `registerEditorProvider` 导出路径保留。SDK 动态加载、原生 session/preflight 绑定、stopEpoch、模型租约 finally 释放与审批/隔离工具包装不变。

构建、完整测试 642/642、相关文件 noUnusedLocals、`check:local`（12 tools）、`cloud-preview --check`、diff 检查通过。主代理审查没有发现未解决问题。未调用真实模型或重新验证云端实际部署。
