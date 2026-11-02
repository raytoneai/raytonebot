# Observer 本机补齐记录

2026-11-02。基线 `b97d55b` 加本轮改动，以下记录提交前的验收快照；未推送或部署。用户范围为优化本机遗留，subagent 实施、主代理 review；真实模型效果和逐平台部署另算。

## 完成内容

- 独立问答检查通过主机真实一次性入口交换取得 cookie/CSRF，保留匿名拒绝与原业务验证；实际请求工厂纳入不依赖 CLI 的回归。BrowserView 延迟演示同步迁移会话初始化。[脚本实测记录](script-checks.md)。
- 原开发者设置 finding 内录入实施/效果并打开实际来源轮次，原 Output 展示记录。来源限定本实例普通公开会话，保存独立 revision 及主机操作者信息；明确结论有来源要求，但始终标为用户记录，不宣称自动验证收益。
- 支持 stale finding 的历史补记，不改变批准或恢复有效性；并发冲突保留草稿供显式重试。删除关联来源清除受影响实施段或整个效果段，包括标准、样本、成本与引用，保留独立原 finding。
- 沿原 schema 可选扩展，保存原子化、有界，兼容旧记录；没有自动实施、模型评测或新的服务/面板。

## Review

主代理发现并要求 subagent 修复：

1. Output 原先仅绑定 finding revision，独立 follow-up 更新/删源后会保留旧正文；现绑定 followUpRevision 并关闭过期报告，原证据仍按自己的版本。
2. UI 若按删除时间戳比较，同毫秒或时钟回拨会漏清第二次删除的草稿；现按独立 revision 和删除段状态处理。
3. 后续记录不再复制到 Observer 聊天投影，完整内容只在设置/Output 展示，避免扩大需清理的缓存面。
4. 来源版本明确是会话元数据快照，不是冻结的正文存档；改名/继续会话后设置可显示已变更，部分加载不误报来源丢失。
5. 实际截图发现全局 select 固定高度把多选来源压成单行；局部按 size 显示多行，避免选择框和已选来源列表造成误读。

独立 Standards review：硬问题 0 项，判断建议 0 项；沿既有 owner、runtime/host 分工与权限边界，无无关重构。独立 Spec review：0 项明确缺陷；未发现本轮两项补齐偏离契约。两位 reviewer 只读审查，没有重跑测试；主代理另做集成与实际截图检查。

## 验证

最终结果：所有测试使用临时数据、受控 runner 或本机协议端点，不连接真实模型账号。修改的源码/测试/脚本哈希见 [source-hashes.json](source-hashes.json)。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过；仅原有 chunk 大小提示 |
| `npm test` | 954 项，953 通过、1 项既有 DSH 环境跳过、0 失败 |
| 后端定向回归 | 39/39 通过，含新增 8 项 follow-up 行为测试 |
| 前端定向回归 | 17/17 通过，含新草稿/快照/删除/缓存及三语 owner 浏览器用例 |
| `node scripts/check-user-input.mjs` | 实际 Pi SDK/Claude CLI 对本机受控端点，回答/跳过/停止 6/6 |
| BrowserView 普通与 slow `--check` | 匿名 401、真实会话 200，通过；仅 HTTP smoke |
| 隔离 `check:local` / `cloud-preview --check` | 通过；12 个工具、空 prompt 400、跨源 403、可信云入口与会话归一化 |
| 实际完整 App follow-up 流程 | 7 项流程全部通过，14 张截图，0 非预期 page/console error，刻意制造的 Observer 409 单独记录 |
| 三语实际设置 | zh/en/ja、桌面/390px；保存、刷新、冲突重试、来源跳转、撤销；文档宽度均 390px，多选框可显示两个选项 |
| 内置 devtools 场景 | 桌面与 390px 各 20 个，40/40，启动及场景无错误 |
| 文档与补丁 | 27 个新增/变更本地链接及锚点通过；`git diff --check` 通过 |

- [构建日志](build.log)、[完整 Node 测试日志](npm-test.log)、[云入口自检](cloud-check.log)。
- [独立问答与 BrowserView HTTP smoke](script-checks.md)。
- [真实授权设置与 check:local](auth-ui-results.json)、[40 个开发场景](fixture-results.json)。
- [实际完整 App follow-up 结果](followup-ui-results.json) 和 [可复跑脚本](check-followup-ui.mjs)；仅受控 owner 的异步/三语回归：`src/runtime/observerFollowUpUi.test.ts`，截图在 `controlled-owner-ui/`，两种证据不混称。
- 主代理查看了实际中文桌面、日文 390px、删除后的 Output 及 owner 截图；[两项来源可见](followup-zh-desktop.png)、[日文窄屏](followup-ja-mobile.png)、[删除后的报告](followup-output-after-delete.png)。

验证脚本最初照搬 SSR 的 `ws: false`，导致真实 Vite client 的 WebSocket console error；40 个场景本身正常。恢复正常 WS 后重新检查启动与场景，不把脚本配置错误隐去或计作产品失败。流程脚本另修正嵌套 summary 选择器及 Output 遮罩操作；删源测试明确保持 Observer 为当前会话，排除删除活跃普通会话导致面板顺带关闭的假阳性。

全 App fixture 原先设 `browser: false`，启动时正常浏览器状态请求产生 404；最终改用临时默认 BrowserService，使状态端点正常可用。没有忽略这些 404，没有启动真实用户 profile 或调用浏览器模型工具。最后无非预期 console error。

## 仍未验证

- 真实 L1/L2 模型质量、同模型/配置及新会话的 RSL 收益与成本对照。用户填写的“改善”不是评测结果。
- 线上部署、逐平台 UID/网络与更新/回滚/恢复；本轮未重跑无变更的发布打包流程。
- 固定 DSH 环境跳过仍保留。BrowserView 普通/slow 自检仅验证认证 HTTP，不提供新的 p50/p95 测量结论。
