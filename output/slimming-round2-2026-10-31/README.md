# 第二轮瘦身：自适应侧栏 · 2026-10-31

基线 `741d7df`。快速子代理实现，主代理 review、浏览器验收后单独提交。此次只提取 `useAutoHiddenRails(frameRef)`：容器宽度观测、660/860 断点、左右栏隐藏状态与 observer 清理迁入 `src/runtime/`；shell 保留布局、欢迎页、手动折叠、抽屉和输出面板的组合判断。

`agent-shell.tsx` 1,941 → 1,915 行；新增 hook 36 行。主文件减少 26 行，两个源码文件合计增加 10 行，收益是职责集中。本轮不继续拆会话/流式状态机。

## Review

- [AST 对比](review.json)：原 observer 回调、阈值与初始状态逐字相同。包括首次测量、无 ResizeObserver 时返回、entries 回退、状态未变时复用对象及 disconnect 清理。
- 调用放在原 observer effect 位置，保留相对主题 effect 的执行顺序；依赖从 `[]` 改为 `[frameRef]`，唯一调用方仍使用稳定 `useRef` 对象。
- 未改 CSS、组件结构、断点、折叠状态语义、模型或权限。

## 验证

- [构建](build.log)通过；保留既有 Vite 配置扩展名和 chunk size 提示。
- [默认并发完整测试](tests.log) 642/642，无失败、取消或跳过，约 17.89 秒。
- [本机接口检查](local-check.log)、[云入口检查](cloud-check.log)、diff 检查通过；均未调用模型。
- [浏览器记录](ui-results.json)：容器 659/660/661、859/860/861px 与 390px，隐藏条件均为严格小于断点。记录同时保存 viewport 与容器宽度，避免把页面留白误当成断点偏移。
- 390px 抽屉打开，Escape 关闭并把焦点交回展开按钮；拉宽到容器 660px 后抽屉关闭，再缩窄不自动重开。手动折叠状态跨手机/桌面往返保留。
- 宽屏产物进入右栏，窄屏产物进入弹层；临时工作区合成 HTML 正常预览。欢迎页与全部 19 个事件场景无横向溢出，验证期间浏览器 error 为 0。

验证期间有一次 Vite `server connection lost` 后重连，页面重载使 fixture 回到欢迎页；这次操作不计作 Escape 验收。重新选择场景后，通过页面内键盘操作确认 Escape、焦点恢复和 fixture 内容保留，后续全部场景通过。连接事件保留在 UI 记录中；没有证据将重连归因于本次 hook 提取。

[桌面右栏](desktop.png) · [手机抽屉](mobile-drawer.png) · [手机产物](mobile-artifact.png)

使用隔离临时数据及本机 5196 端口；临时页面、服务与文件测后清理。未调用真实模型、验证线上部署、真实手机系统键盘或浏览器接管；未推送。
