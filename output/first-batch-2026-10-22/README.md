# 第一批移植验收（2026-10-22）

范围：unified diff 文本预览和最后一个打开文件的关闭入口。不包含计划摘要栏、皮肤或头像。

- `npm run build` 通过，保留既有 chunk-size 提醒。
- `npm test`：451/451 通过；新增 diff 原文重建、空文件、CRLF、无末尾换行、跨文件头识别、SSR 文本转义及单文件关闭入口覆盖。已有工具呈现测试补验成功/失败编辑的请求差异与结果分离。
- CUA 浏览器切换 20 个内置场景，均渲染，无浏览器 error；列表在 `fixtures.json`。
- `preview-check.html` / `.tsx` 为隔离的验收页面，直接使用生产 OutputContent、OutputPanelModal 和 ToolCallCard；不调用主机、不写会话或草稿。点击验证单文件关闭后空态、两个文件切换/关闭后回落到单文件标题栏、展开预览关闭最后一项后退出。
- 桌面 1280px 亮暗主题、319px 窄屏实看，补丁里的 `<script>` 作为文本显示。截图：`diff-light.png`、`diff-dark.png`、`diff-narrow.png`。
- 主页面现有会话中打开已有 `llm-architecture.html`，关闭后预览消失，返回产物列表；没有调用模型或改写文件。Coding fixture 关闭显式打开项后恢复其配置的自动产物预览，这是该演示原有的回退路径。
- 本次修改文件的 `git diff --check` 通过；全工作树另有原先 tmp/avatar-eye-study 文件的尾随空白，本次未动。

未验证真实模型新一轮输出或云端部署。没有提交推送，保留工作树原有改动。
