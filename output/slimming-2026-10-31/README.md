# 分批瘦身验收 · 2026-10-31

## 第一批：无引用旧代码

基线 `7d54945`。实施由 gpt-6-luna 子代理完成，主代理独立审查引用链、barrel、依赖锁和文档后提交。净删约 7,000 行旧源码/文案/样式及锁条目；主要收益是减少维护噪音，不以此推断启动性能提升。

- `npm run build` 通过（原有 chunk size/Vite native config 提示保留）。
- `npm test`：642/642，通过，无跳过。
- `RAYTONEBOT_URL=http://127.0.0.1:5196 npm run check:local`：UI、Pi SDK、12 tools、空 prompt 与跨源拒绝通过。
- `node scripts/cloud-preview.mjs --check`、`git diff --check` 通过。
- 隔离临时数据/工作区，IAB 390 × 844 欢迎页及 19 个事件场景通过；[结果](cleanup-fixtures.json)，[截图](cleanup-fixture.png)。

保留 `vendor/`、穷举 slot registry、ExportFrame/scaffoldManifest stub、GitPreviewState 类型入口、Pi 事件适配和所有开发场景。修正架构文档中旧视图模型仍在使用的过时说明。未调用真实模型，未部署或推送。
