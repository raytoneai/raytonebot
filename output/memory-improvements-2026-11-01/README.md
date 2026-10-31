# T6.10 记忆可靠性分批验收

用户授权按优先级实施，subagent 负责代码，主代理独立 review、验证并逐批提交。起点 `1162313`；不修改真实用户记忆、模型或权限，不推送或部署。

## 第一批：可靠读取

- `recall_memories` 增加可选 cursor/nextCursor，最多 20 条/页。游标绑定持久版本、规范化查询和 Bot/群范围；变化后明确报过期，重新从第一页读取。43 条匹配跨三页无遗漏/重复；跨范围、无效及过期游标不返回数据。
- 提示和查询按更新时间排序。编辑条目移到保存序列末尾；时间重复或回退时仍优先，重启保持稳定。长列表的旧条目修改后进入约 4000 字符提示。
- 成功的 Pi compaction_end、Claude compact_boundary、Codex contextCompaction/thread-compacted、DSH compaction/end 使当前范围投递失效。显式原生重置清当前会话所有范围。旧投递回执不能确认新状态；下一用户轮次补发一次，之后恢复仅变化时发送。
- CLI 边界使用主机内部事件，不进入 UI adapter。DSH 沿既有私有 socket 通知，核对活动 session，flush 等待回执。未改原生 SDK、审批或模型。

主代理审查补充：编辑同毫秒/回退时的排序、会话重置的全部范围、失败重置不失效、关闭/清空后的忽略提示、压缩后迟到的接受回执。没有每轮重复注入全部记忆。

验证：

- `node --test src/pi/memories.test.ts`：18/18 通过。
- `npm run build`：通过，保留既有 chunk 大小提示。
- `npm test`：748 项，747 通过、1 项安装环境相关 DSH 跳过、0 失败。
- `node output/memory-improvements-2026-11-01/check-local.mjs`：创建临时目录/随机端口运行既有 `npm run check:local`，通过并清理；无模型请求。
- `node scripts/cloud-preview.mjs --check`、`git diff --check`：通过。

日志：`batch1-memory-tests.log`、`batch1-build.log`、`batch1-tests.log`、`batch1-local-check.log`、`batch1-cloud-check.log`。

限制：未用真实外部模型构造长对话压缩，不承诺同一轮内自动重试已经补回记忆；旧 Codex 原生线程保留原 dynamic tool schema，分页参数可能需新建会话后才可见。本批无 UI/事件投影改动，未重复视觉验收。后续内容维护、项目交接和导出仍待各批实施。
