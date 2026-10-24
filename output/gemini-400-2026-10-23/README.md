# Gemini HTTP 400 排障

2026-10-23，本机实际页面。

## 已确认

- Gemini 已为默认服务，页面持有会话密钥；本次错误发生在模型请求阶段，不再是 DeepSeek 缺 key。
- 官方 OpenAI 兼容接口示例使用 `gemini-3.8-flash`。在用户页面把 `models/gemini-3.8-flash` 规范为同一模型的短 ID，重发原 `hello` 后仍然 400，因此不能将前缀认定为根因，也未加入自动模型替换规则。
- 网关对所有上游错误直接取消正文，只返回 HTTP 状态，丢失了 Google 的诊断原因。旧响应无法追溯。

## 已改

`src/pi/runtime/providerError.ts` 在 1 秒内读取最多 16 KiB JSON，只提取 error.message/message，输出上限 600 字符；过滤当前上游 key、租约 key 及常见编码/凭据格式，不返回 headers、HTML、完整 JSON 或 401/403 的认证详情。网关保留原状态码并带上安全处理后的原因，Google 的错误 JSON 数组也会提取 message；错误处理不自动重试。

真实错误随后确认为 `Invalid JSON payload received. Unknown name "store": Cannot find field.`。Pi SDK 默认发送 store=false，已在 registerEditorProvider 中依据原始官方 Google endpoint 设置 compat.supportsStore=false，保持 loopback 租约、选定模型及其他 provider 行为。真实已安装 SDK 回归先失败后通过。

## 验证与待办

- 新增回归先失败后通过，覆盖错误原因保留、上游/租约 key 和常见编码过滤、HTML/非法/超限/超时退化、认证错误不回显、真实网关状态码及 cookie 隔离。
- build、全量测试及 check:local 日志在本目录。构建保留既有 Vite 配置和 chunk 大小提示。
- 加载主机修改触发 Vite 重载，页面和主机的临时密钥确已清空。已打开 Gemini 设置，请用户在原页面重新填写并保存；不通过聊天收集密钥。
- **400 的 store 字段根因已确认并修复；真实 hello 尚未成功。** 用户重填后重试长时间无回复，已停止。本轮随后按用户纠正实现主机密钥持久化，见 [持久化验收](../provider-persistence-2026-10-23/README.md)，不再把内存保存称为完成。

参考：[Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)。
