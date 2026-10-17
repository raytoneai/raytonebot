# 2026-10-17 仓库评审证据

基线 `0d458dc`，对应 [评审报告](/Users/rickyhuo/RaytoneBot/docs/repository-review-2026-10-17.md)。

2026-10-18：相关 sandbox 缺陷已修，以下探针作为 `0d458dc` 的历史复现证据保留，不适用于当前工作树（含内部记忆接口变化）。当前正向回归进入 `npm test`：`settingsStorage.test.ts`、`browserWorkflow.test.ts`、`piHost.test.ts` 和 `memories.test.ts`。外部 control 的探针结论仍未修，按用户要求暂缓。

- [storage-memory-probes.mjs](/Users/rickyhuo/RaytoneBot/docs/review-evidence/2026-10-17/storage-memory-probes.mjs)：真实临时文件读写；配置损坏覆盖、control 保存失败、审批内存/磁盘不一致、附件失败后漏记忆。最后一项通过真实主机控制器和 fake bridge，不调用模型。
- [browser-download-probe.mjs](/Users/rickyhuo/RaytoneBot/docs/review-evidence/2026-10-17/browser-download-probe.mjs)：本机真实 Chromium、临时 profile、loopback HTTP 分段下载；会话 B 的只读工具改变会话 A 下载归属。
- [verification.txt](/Users/rickyhuo/RaytoneBot/docs/review-evidence/2026-10-17/verification.txt)：完整 Node 测试、构建与 Python 运维测试的日志末尾。
- [probe-results.txt](/Users/rickyhuo/RaytoneBot/docs/review-evidence/2026-10-17/probe-results.txt)：上述复现脚本的实际输出。

从仓库根目录运行：

```sh
node docs/review-evidence/2026-10-17/storage-memory-probes.mjs
node docs/review-evidence/2026-10-17/browser-download-probe.mjs
```

需要仓库要求的 Node 版本及已安装依赖；浏览器探针还需要已有 Chromium headless shell，并允许本机端口与子进程。使用临时目录并自行清理，不读取用户 profile、模型 key 或云端凭据。请在未开启生产隔离环境变量的本机开发环境执行。

这些脚本**断言当前缺陷存在**，所以当前通过意味着问题复现；产品修复后应将相应场景改写为期望正确行为的回归测试。它们不在 `npm test` 默认范围内。

额外检查：本机 `npm run check:local` 与 `node scripts/cloud-preview.mjs --check` 均通过；前者未请求模型，后者只运行本地鉴权断言，不是线上验收。
