# 设计评审优化：分批实施与验收

用户授权：根据 [Claude 微件设计对照评审](../../docs/claude-widget-design-review-2026-11-02.md) 派快速子代理实现，由主代理 review、验证后逐批 commit。保留现有组件 owner、字体、头像、模型、权限和部署状态。

## 第一批：HTML 产物可读性与静态首屏

- 原 `artifactThemeCss()` 使用现有 Radix 浅深色阶 3/8/12 分离背景、描边、标签色；八种旧 `.c-*` 和 `--c` 保留，旧节点无语义类的标签继续自动着色。
- 新 `.t/.ts/.th` 显式选择普通/次要/标题文字色；语义类限定 SVG text，不为所有无类 SVG 文字全局覆盖作者设计。生成指引要求每个 SVG text 带语义类。既有不使用这些类的任意文档不会被自动改造。
- 原提示词补充短 style → 可见静态内容 → script；保存前脚本不执行，图表先给静态摘要，再增强交互。保留现有沙盒、桥、点击和队列规则。
- 主代理 review 发现初稿蓝色标签对比 4.25:1、主题 CSS 压过作者类、旧无类标签回退为背景色；修正后再补齐文字继承节点描边的回归，去掉冗余变量并限制语义类范围。作者显式 fill、inline style、CSS class 和 stroke 均可保留。
- 定向 24/24 通过。真实 Chromium 测得八种节点/页面上的标签最低对比为浅色 10.34:1、深色 11.37:1；独立普通/次要/标题文字也达到 4.5:1。分段静态内容可见、保存前脚本/事件属性无执行、完成后按钮可交互。
- `npm run build` 通过（保留既有大 chunk 提示）；完整 `npm test` 984 项：983 通过、0 失败、1 项既有 DSH 环境跳过；隔离本机 HTTP 和云入口自检通过。
- 复用已有开发场景脚本，桌面/390px 各 20 项、40/40 渲染检查通过，无启动/场景错误。主代理查看浅深 SVG、HTML 流式场景和审批截图。

上述验证使用受控内容，不证明真实模型一定遵守新指引，也未验证真机或部署。完整测试使用 Node v26.13.0；截图和日志只留本机。

## 第二批：手机设置与触屏消息操作

- 原 SettingsDialog 在 <=720px 使用现有原生 `Select`，与桌面按钮共用 nav 数组和 section 状态；保留 Dialog.Title 的可访问文本。桌面 rail、初始分类、dirty close 和草稿管理不变。
- 原 MessageActions 在粗指针下为 44×44px、相邻间距 6px，图标保持 14px；桌面仍为 28×28px。没有新增组件、设置面板或状态层。
- 主代理 review 补上实际 select 的 `max-width:none`，避免只把外层撑满、内层仍受全局 190px 限制；移除测试中为凑齐 11 项添加的无效空能力对象，保留缺省能力只显示七项的兼容性检查。
- 现有设置浏览器测试新增可见导航操作、初始 memory、外观切换与 390↔1280 当前分类保持、焦点/Tab 路径；原非秘密草稿、保存前提和 Vault 清除继续通过。定向 13/13 通过。
- 隔离实际 App 检查 zh/en/ja × 浅/深 × 1280/390 共 12 组：11 项真实导航、记忆/凭据/外观/关于可达、满宽且 >=44px 的选择器、按钮尺寸和图标、无页面溢出和 pageerror。主代理查看中文窄屏设置/群聊、日文暗色设置截图。
- 完整测试 984 项：983 通过、0 失败、1 项既有 DSH 环境跳过；构建、隔离本机/云入口和 40/40 开发场景通过。

键盘焦点和 Tab 路径已验证。macOS 无头 Chrome 的原生 popup 不响应自动化方向键选择；分类 change 通过 Playwright 原生 selectOption 验证，真实 OS 选单的方向键行为与真机触控未验。没有修改原生键盘语义来适配测试。

## 第三批：语义字重与设计约定

待执行。实际主界面字重归入现有 token，完善 `.impeccable.md`，修正失效设计文档引用。不统一替换字体或调整正文大小。

## 复跑入口

```sh
node --test src/runtime/artifactTheme.browser.test.ts src/runtime/artifactBridge.test.ts src/runtime/liveHtmlWrite.test.ts src/pi/rolePrompt.test.ts
npm run build
npm test
node output/run-reliability-2026-11-02/check-local.mjs
node scripts/cloud-preview.mjs --check
node output/run-reliability-2026-11-02/fixture-browser-check.mjs
```

浏览器检查使用已安装 Chromium 和隔离临时数据，不调用真实模型。复用已有 fixture 脚本；生成日志、JSON 和截图只留本机，仓库保留本摘要与行为回归。实际结果和限制随各批更新。
