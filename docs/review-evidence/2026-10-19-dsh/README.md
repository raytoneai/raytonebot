# DSH 本地接入验收 · 2026-10-19

环境：macOS，本机 Node 24.14.0，RaytoneBot Vite 127.0.0.1:5188。没有部署、推送或调整其他引擎的模型。

## 版本与范围

- npm 官方 `latest`、`next` 均为 `0.2.1-rc.2`；本机 CLI 从 `0.2.0-rc.2` 升级，桌面客户端 Info.plist 为 `0.2.1-rc.2`，无需更新。
- 运行器固定已验证版本；实际 CLI 入口 `/Users/rickyhuo/.local/bin/dsh`。没有把 DSH 添加为前端 npm 依赖。
- 官方源码依据：[固定提交 687f282](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)。实现决策见 ADR-050。

## 已完成

1. `npm run build` 通过；仅保留已有大 chunk 提示。
2. `npm test`：444/444 通过，含新增 8 个 DSH 协议、授权绑定、取消、配置与 Bot 测试。
3. `npm run check:local` 通过（UI、SDK、12 工具、空请求和跨域拒绝）。
4. `node scripts/check-dsh-local.mjs`：实际已安装 DSH + 本地可控 Anthropic 响应，8 次模型协议请求；原生写入、拒绝后无文件、宿主工具恰好执行一次、缺失 session 不请求模型、换进程原生 resume，以及停止 shell 并确认 sleep 子进程不存在，全部通过。该项不使用真实模型。
5. Chrome 实际创建 **DeepSeek** Bot，真实 DeepSeek `deepseek-flash` 通过 DSH 调用 glob、remember、write、read。既有审批事件出现在执行前；最终 run.finished=success。写入 `output/dsh-local-check/note.txt` 内容为 `DSH native tool verified`，右侧文件预览正确。测试记忆之后删除，避免污染后续对话。
6. 真实会话 `pi_cd716c7f-cd17-4812-a183-3049c1312a18` 保存 DSH 原生 id；开发服务重载、重新开页面后历史与产物可恢复。修复了选择可选引擎后刷新、Bot 列表尚未加载时的空身份错误。
7. `?devtools=1` 的 20 个选项逐一渲染：思考、工具、审批、错误、重试、耗尽、终止、中断、产物等均无页面崩溃或横向溢出。记录与截图位于 `output/dsh-local-check/fixtures/`。
8. 新增 preset 后旧三角色 AGENTS.md 模板迁移仍正确，编辑过的文件保留；新引擎不自动创建默认 Bot。凭据/数据目录与已有权限规则继续生效。
9. 用户重新保存模型 key 后，真实 `deepseek-flash` 续接同一原生 session `7f8566fc-8a1c-489a-a765-b977101d896f`：不调用工具，精确回忆此前文件内容。随后拒绝一次原生 `edit`，审批前后文件字节不变；批准本地 `sleep 30` 测试命令后调用停止，run.finished=cancelled，实际子进程 PID 已不存在。取消后继续同一 session 正常回复「DSH 已就绪」。没有清除用户的 remember/write 始终允许设置，没有改动运行时代码或重启服务。证据：`output/dsh-local-check/live-followup.json`、`live-followup.log`、`after-stop.json`、`live-followup.png`。

## 边界

- 原生进程重启续接、拒绝与子进程清理现有可控端点和真实 DeepSeek 模型两组证据；不等同于 Linux 或全部宿主工具验收。
- ACP 只展示已提交文本；不支持原生历史 fork、PTC、自主子 Agent/后台任务。
- 未做 Linux 隔离、云部署、真实外部 MCP/浏览器交互/IM 的 DSH 专项验证，沙箱模式主动拒绝。
- 本地模型 key 仅在内存，不写入文件或提交。服务端重启会清空服务端副本；仍持 key 的浏览器在发送前通过 `synchronizePiRuntime` 同步。只有浏览器的会话内 key 也丢失时才需重新填写，不能单凭 `/state.sessionKeyProviders` 为空判断用户没有配置。

## 重跑

```sh
npm run build
npm test
node scripts/check-dsh-local.mjs
npm run dev
npm run check:local
```
