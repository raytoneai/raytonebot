# UI 优化验收（2026-10-23）

按 [审查建议](../ui-principles-review-2026-10-23.md) 实施，保留原组件归属、布局及已有工作树改动。

## 变更

- 简化中英日产品文案、工具摘要与设置元数据；删除重复产物标题和模型服务首屏说明。权限文案不改变授权行为。
- `@radix-ui/colors@3.0.0` 映射到现有亮暗语义 token。按 [官方色阶用途](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) 分配背景、交互态、边框与文本；暗色琥珀按钮使用深色前景。
- 产品控件使用 12/14/16/18px 四档，静态边框 0.5px；设置导航分组、元数据换行和嵌套圆角统一。去掉多余选中阴影、点击缩放、标题闪动；图像显现改为 250ms ease-out 的透明度过渡。
- 品牌头像、第三方标识、用户产物和 Markdown 内容不强制换色/字号；焦点环、加载状态和具有语义的描边保留。

## 验证

- `npm run build`：通过（build.log）；已有分包大小提示仍在。
- `npm test`：451/451 通过（tests.log）。后续仅做 CSS、空态文案与 aria-label 收尾，已再次构建。
- `npm run check:local`：通过（check-local.log），无模型请求。
- 20 个 devtools 内置场景逐一切换，DOM 与布局检查成功，无页面横向溢出；名称、尺寸记录见 fixtures.json，截图 fixture-0.png 至 fixture-19.png。重点实看审批、错误与重试耗尽。
- 浏览器主页面与 fixture 页面 error 日志均为空。
- 1280×720 亮暗设置、聊天/输出区域实看；320px 模型服务与 390px 权限布局无页面横向溢出，权限页计算字号为 12/14/18px。窄屏截图通过 CDP 的显式 clip 捕获（普通截图在视口模拟时缩放异常），已清除模拟并恢复亮色。
- 本轮 src、package 与进度文档 `git diff --check` 通过；全仓检查仅报告原有 tmp/avatar-eye-study 文件尾空白，未改这些文件。

## 截图

- [亮色设置](settings-light.png)
- [暗色设置](settings-dark.png)
- [320px 模型服务](settings-320.png)
- [390px 权限](permissions-390.png)
- [聊天与输出](chat-output-light.png)

## 边界

未进行真实模型调用、云端部署、完整键盘/屏幕阅读器验收或物理设备不同像素密度检查。未更改模型、权限和频道配置，原有草稿保留；未提交或推送。

## 提交前隔离复验

从暂存区导出独立目录，排除此前尚未提交的审批/输出面板/头像实验改动后，`npm run build` 与 444/444 项测试通过。见 staged-build.log、staged-tests.log。上述 451 项是完整工作树结果；本次提交只包含本轮 UI 优化与证据，未包含修改既有未提交功能所需的局部文案/边框收尾，这些仍保留在工作树中。服务继续使用完整工作树，`check:local` 通过，http://127.0.0.1:5188/ 返回 HTTP 200。
