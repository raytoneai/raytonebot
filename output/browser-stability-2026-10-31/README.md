# 浏览器稳定性实测 · 2026-10-31

基线 `422fe0f`。本轮由快速模型子代理执行真实 Chromium 测试，主代理审查实验和证据；测试执行由单个代理负责，其他代理只读检查，避免额外浏览器活动干扰。使用测试自建的本机站点、临时 profile 和虚拟凭据，未调用真实模型或外部站点。

## 原样复现结果

| 实验 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 默认并发全量 1 | `npm test` | 642/642，无失败或跳过 | 20.63 秒 |
| 聚焦 popup / worker 生命周期 | `node --test src/pi/browser/browserWorkflow.test.ts src/pi/browser/workerLifecycle.test.ts` | 23/23，无失败或跳过 | 16.04 秒 |
| 默认并发全量 2 | `npm test` | 642/642，无失败或跳过 | 17.40 秒 |

原始输出：[全量 1](npm-test-run-1.log)、[聚焦用例](focused-browser-run-1.log)、[全量 2](npm-test-run-2.log)。首轮外层采集脚本曾因给 zsh 只读变量 `status` 赋值返回错误；这是测试结束后的包装脚本错误，Node 测试的总结是 642/642。后续采集已避开该变量，未将包装失败记作产品测试失败。

[环境](environment.txt)：macOS 26.5.2 / arm64、Node 24.14.0、Chromium headless shell 156.0.8078.4。环境快照的进程匹配数量可能包含 renderer/utility，不能解释为同时运行的浏览器实例数，也不是持续采样峰值。

本轮没有重新运行此前已通过的 94 秒串行全套；历史默认并发失败及串行结果仍见[第一轮瘦身验收](../slimming-2026-10-31/README.md)。本轮两次默认并发通过不覆盖或否定那些失败记录。

## 临时插桩与主代理 review

最后使用临时元数据插桩运行上述两个浏览器测试文件，默认并发 **23/23 通过，16.62 秒**，见[最终原始日志](final-diagnostic-run.log)、[命令](diagnostic-command.txt)及[观察说明](diagnostic-observation.txt)。

- 慢下载 popup 用例：目标匹配 33ms；从点击开始到 summary 完成 320ms。所有记录到的 popup wait 均为 `matched`，耗时 26–55ms，没有走 5 秒超时兜底。
- 记录到的三个 Chrome 退出均为 `code=0`、`signal=null`、`closing=true`；worker 也正常退出。关闭请求先于 context close / browser disconnected，属于本次主动清理的正常时序。
- 主代理 review 修正了临时插桩中的硬编码关闭标记，改为真正发送关闭请求时记录，并补齐 Chrome 退出当时的状态。未修改产品超时、断言、全局并发或审批语义。
- 插桩开发期间的中间输出未完整归档：第一次单项运行只有观察摘要，第一次组合日志随后被修正后的组合日志覆盖。以上时序结论只采用最终原始日志；不会把中间日志作为已验证的退出原因证据。

源码插桩已全部撤回；[诊断补丁](temporary-diagnostics.patch)仅作为复现附件，不是已启用的产品功能。主代理核对保留源码与基线无差异、补丁可应用，且 288 条诊断事件只含阶段、时长、关闭状态和退出码/信号，无页面内容、URL 或凭据。仅接入 logger 的实例有日志，这不是整台机器的进程退出审计；插桩时长也不是正式性能基准。

需要再次诊断时，在源码与基线一致的干净工作区执行，测试完成后撤回同一补丁：

```bash
git apply --check output/browser-stability-2026-10-31/temporary-diagnostics.patch
git apply output/browser-stability-2026-10-31/temporary-diagnostics.patch
RAYTONEBOT_BROWSER_DIAGNOSTICS=1 node --test src/pi/browser/browserWorkflow.test.ts src/pi/browser/workerLifecycle.test.ts
git apply -R output/browser-stability-2026-10-31/temporary-diagnostics.patch
```

## 退出原因的证据边界

只读筛查 macOS DiagnosticReports，未发现与此前 CSS 失败窗口（北京时间 2026-10-31 00:45–01:11）或本轮窗口匹配的 Chromium 崩溃报告；无关时段的报告未打开。没有报告不能证明浏览器未异常关闭，也不能据此断言资源竞争。

现有 popup 测试的 4 秒期限和 worker 的 5 秒兜底等待仍保持不变。该测试也保护慢下载下的页面切换，不能仅凭两个数字直接提高超时。未复现原故障时，不进行推测性产品修复。

结论：**本轮未复现，历史根因仍未确定，不能宣称已修复。** 未更改默认测试并发、跳过用例或放宽超时；未部署或推送。由于最终仅保留文档/日志/诊断补丁附件，没有重新构建或重复 UI 场景验收。
