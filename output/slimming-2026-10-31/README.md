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

## 第四批：运行控制器与 HTTP

基线 `c13d7d1`。`piHost.ts` 变为 7 行兼容导出入口，`piRuntimeController.ts` 1,196 行、`piHttpHost.ts` 746 行、共同校验 `piHostUtils.ts` 16 行。16 个原函数/类型声明经 AST 对比一致且无重复。HTTP 直接依赖 controller，没有反向运行时依赖，路由顺序/主机服务组合/释放不变。

构建、typecheck、相关文件未使用声明检查、`check:local` 和 `cloud-preview --check` 通过。首次完整测试 641/642：`browserWorkflow.test.ts` 的 popup 点击超过原 4 秒期限；该测试直接调用未改动的 browserService/browserWorker，不经过拆分模块。单独复跑 1/1（约 1.3 秒），未改代码或超时，完整复跑 642/642。保留 [首次输出](host-tests.log)、[单项复跑](host-browser-recheck.log) 和 [完整复跑](host-tests-recheck.log)；偶发超时具体原因未确定，不宣称已修复。未验证真实模型或线上部署。

## 第五批：输出面板状态

基线 `1c8d6ce`。92 行 `useOutputPanel` 聚合显示状态和标签/来源操作；shell 仍有 1,941 行，这只是首个边界提取，会话运行逻辑尚未拆分。主代理逐项审查 item id/path 合并、active/last close、当次面板可用性及三个 reset 的范围，并撤回额外的 effect 依赖调整，保留原触发语义。

构建、完整测试 642/642 和 diff 检查通过。IAB 实测：390px 临时 HTML 文件预览、重复打开只有一个标签、关闭最后项收起弹层；1280px 侧栏打开与控制台/工作区切换；新会话回到欢迎页并折叠输出。全部 20 个场景无横向溢出，检查开始后的浏览器 error 为 0。[结果](output-ui.json)、[产物弹层](output-after.png)。使用临时目录内合成 HTML，无模型调用；真实任务自动预览、浏览器接管本次未重新端到端验证。

## 第六批：群聊规则与提示词

基线 `ec77d61`。`groupChat.ts` 1,065 → 701 行；路由策略/请求在 293 行 `groupChatRouting.ts`，提示词在 98 行 `groupChatPrompts.ts`。主代理 AST 比较全部 55 个原函数主体、类型与变量 initializer，包括正则和提示词，均相同且无重复；原公共导出集合一致。run/attach、恢复、审批归属和委派流程保持原样。

构建、完整测试 642/642、本机接口、云入口、diff 检查通过。新模块无未使用声明；旧状态机原有 unused `mentioned` 仍保留，未借拆分改动该函数。未调用真实路由模型或线上验证。

## 第七批：旧预览与配置器样式

基线 `2dbde33`。仅删除 `app.css` 中 269 条完整归属旧 `.pv` 或配置器前缀的规则，以及删除后无引用的 7 个 keyframes；混合选择器、实际 `.preview-frame`/产物/媒体样式仍保留。`preset-skel-shimmer` 和 `preset-accordion-in` 仍有使用者，未删。13,205 → 11,330 行，净删 1,875 行/48,438 字节。

主代理用 PostCSS 独立比较基线与结果：所有保留规则的声明、顺序、上下文一致（忽略注释和删除后为空的容器）。[审查数据](css-audit.json)。构建通过，主样式产物 323.73 → 287.27 kB，gzip 50.31 → 44.88 kB。

首次默认并发测试 625 通过、16 失败、1 取消：审批快照失效、Vault 超时和浏览器关闭后的连锁失败。受影响三个文件单独复跑 35/35；第二次完整默认并发 641/642，仅 popup 下载点击超过原 4 秒期限，该失败在 CSS 修改前的第四批已出现。浏览器用例使用自身独立 HTML，不加载应用 CSS；测试代码/超时均未修改。保留 [首次输出](css-tests.log)、[三文件复跑](css-browser-recheck.log)、[默认并发复跑](css-tests-recheck.log)。

随后使用相同测试文件集合、仅加 `--test-concurrency=1`，完整串行通过 642/642（94 秒，无跳过），见 [串行输出](css-tests-serial.log)。只读排查发现 popup 用例的 4 秒 deadline 小于 worker popup discovery 的 5 秒等待上限；并发负载可能暴露慢路径，但没有证据确定具体触发原因，也未发现跨测试清理同一浏览器的直接证据。浏览器关闭的原因仍未确定，不将串行通过表述为默认并发问题已修复。

390px 欢迎页和全部 19 个事件场景、1280px 设置页、390px 实际临时 HTML 产物弹层通过；最终检查浏览器 error 为 0。[UI 记录](css-ui.json)、[设置](css-settings.png)、[产物](css-output.png)、[审批](css-approval.png)。测试使用隔离临时数据，未调用真实模型、修改真实凭据、部署或推送。

本轮源码及依赖清单/锁文件合计净减 8,710 行（不计文档和验收产物）。`agent-shell.tsx`（1,941 行）与 `piRuntimeController.ts`（1,196 行）仍是后续可维护性重点；本轮只提取已确认的职责边界，未重写其运行状态机。

后续[浏览器不稳定性实测](../browser-stability-2026-10-31/README.md)：两轮默认并发全量与定向诊断通过，本轮未复现；原失败记录仍保留，根因尚未确定。
