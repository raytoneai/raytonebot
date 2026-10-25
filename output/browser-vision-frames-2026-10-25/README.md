# 原生浏览器视觉与 iframe 验证（2026-10-25）

已在现有 Playwright 浏览器实现，无 LCU 依赖、无新 UI、未改默认模型、未部署。

## 已验证

- `browser_screenshot({snapshotId})` 返回当前 1280×800 JPEG（最多 2 MiB），模型继续使用 ARIA refs 操作。对话归属、旧快照、取消和接管限制保留。
- 实际 Chromium 合成页面：跨域 iframe 中文填写，不影响同名父页面输入框；嵌套 frameRef 区域读取和输入/Backspace；POST 审批；按子帧实际 origin 判定已登录站点审批，即使页面脚本改写 window.origin 也不会改变判定；子帧导航拒绝旧目标、旧 frameRef 和旧截图，原有父页面 refs 仍可用。
- 已填写的密码字段（包括子帧）阻止截图；真实 Chromium Vault 虚拟凭据填充后，full/content/interactive 快照仍隐藏且截图拒绝。截图对秘密字段额外遮罩。
- 实际引擎 + 本地脚本模型服务：Pi 1.0.1、Codex CLI 0.162.1（产品 app-server 通道）、Claude Code 2.1.287 的图片 SHA-256 与 browser_screenshot 输出一致。DSH 0.2.1-rc.2 通过原生附件投影送出实际图片，自带 JPEG 重编码，1280×800 尺寸一致，RGB 平均绝对误差为 **0.0513/255**。
- DSH 模型元数据不声明图片输入时给出明确诊断，不保存无用附件；截图以外工具保持原有字符串结果。

## 复现与证据

```sh
node --test src/pi/browser/browserVision.test.ts src/pi/browser/vaultFill.test.ts
node --test src/pi/hostToolImages.test.ts src/pi/browser/workerLifecycle.test.ts
node output/browser-vision-frames-2026-10-25/model-transport-probe.ts
npm test
npm run build
RAYTONEBOT_URL=http://127.0.0.1:5198 npm run check:local
node scripts/cloud-preview.mjs --check
```

模型传输脚本需要本机 Chromium、Pi 以及三种 CLI 均已安装。端点只在 loopback，使用 `local-only` 虚拟 token，不调用外部模型。DSH 的 Files API 在测试端点明确返回 404，以验证它的原生内联图片回退；这是兼容接口路径的验证，不代表已验证真实 Files API 上传。

- [模型请求验证脚本](model-transport-probe.ts)、[三引擎初次传输报告](model-transport-report.json)、[DSH 最终报告](dsh-transport-report.json)。初次 DSH 脚本错误地要求压缩前后字节一致，且没识别 multipart 上传；修正测试端点后单独复验 DSH，尺寸和像素核对通过。这不是产品丢图。
- [原始视口](viewport.jpg)、[DSH 原生压缩结果](dsh-normalized.jpg)，均为无账号、无秘密的合成页面；图片已目视确认标题和橙色 canvas 内容可见。
- [完整测试](tests.log)：**508/508，通过，无跳过**。最后补充截图返回前的帧版本复核及 origin 来源检查后，[浏览器权限/视觉/Vault 定向测试](vision-vault-tests.log) **17/17** 再次通过。
- [build](build.log)、[本地服务检查](check-local.log)、[云入口鉴权自检](cloud-check.log)通过。check:local 在独立临时数据/工作区的本机 5198 端口运行，结束后停止并清理；首次在默认 5188 检查时没有服务，随后完成独立服务检查。
- 本次涉及文件 `git diff --check` 通过；全工作区另有既存 `tmp/avatar-eye-study/avatars.mjs`、`poster.svg` 尾随空白，未修改无关文件。

## 使用与限制

在原聊天中要求 Agent 查看网页图表/布局即可按需调用 `browser_screenshot`；不需要新的设置开关。iframe 使用最近快照中的 `frameRef`，可继续限定 `scope`，不要猜父页面引用。

本次验证的是图片传输与浏览器行为，不是模型读图准确率、复杂生产站点成功率或 LCU 性能对测。没有调用真实模型推理、使用真实账号、部署或推送。Cloud-preview 自检不等于目标云端运行验证。普通远程 MCP 图片解析、任意 JavaScript、像素坐标点击、桌面应用控制和 iframe Vault 填充不在本次范围内。
