# LCU 完整替换检查（2026-10-25）

用户要求在完全可替代时，用 LCU 替换既有浏览器方案。对照实际 BrowserService/worker、Vault、权限与四种引擎入口后，当前未满足完整替换条件，保留产品实现与默认配置。具体差异及一手依据见[完整替换检查](../../docs/lcu-browser-use-comparison-2026-10-25.md#完整替换检查2026-10-25按用户附加条件)。

本轮复验命令：

```sh
node --test src/pi/browser/browser.test.ts src/pi/browser/browserWorkflow.test.ts src/pi/browser/vaultFill.test.ts
```

结果：[18/18 通过、0 跳过](browser-tests.tap)。真实 Chromium 测试使用临时目录、loopback 合成页面与虚拟凭据；没有访问个人 profile 或真实账号。

- 审批分类、秘密字段拒绝、站点授权和停止队列。
- 跨会话/快照/用户接管的引用失效、popup 与实时接管。
- 异步下载、popup 下载、后台 iframe 下载按发起任务归属；停止后和手动下载不误存入其他任务。
- Vault 原 DOM 节点绑定、导航/替换/接管失效、只填不提交、敏感输出与下载保护。

这些检查验证现有实现，不能记作 LCU 功能对等通过。上一轮 LCU 的安装、iframe、截图、Codex 原生图片传输证据继续有效，见[独立 sandbox 记录](../lcu-sandbox-2026-10-25/README.md)；它没有覆盖 RaytoneBot 的产品接入。本轮未唤醒测试 sandbox，未改运行时代码、依赖、部署或模型配置，因此未重跑全量 build/test 或 UI 走查。文档链接及空白检查通过。
