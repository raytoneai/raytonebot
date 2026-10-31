# UI 修正与架构优化合并验收

2026-11-01。UI 提交 `dc501bf` 与架构优化最终提交 `e40f7e3` 已在主工作区 `/Users/rickyhuo/RaytoneBot` 的 `main` 合并，合并提交为 `2cb1da3`。

## 冲突检查与保留范围

- 两边唯一同时修改的运行时文件是 `src/styles/app.css`：UI 改错误详情、标题字重和注释，架构优化改 DebugDock 布局，选择器与位置不同。`git merge-tree` 和实际合并均无冲突。
- UI 继续使用既有 view-model 字段；会话重连、等待状态、帧提交和只读诊断的接口未被 UI 修改。设置轮询修复已经包含在 UI 分支基线中。删除的旧适配器没有被 UI 修改引用。
- 主工作区的 OpenDuet/OpenMausBot 调研修改保持未提交，未混入合并提交。进度文档先备份、合并后恢复研究段落；其他已修改文件逐字节校验不变。旧的未跟踪 UI 审查稿与本任务初稿一致，替换为分支中已补充修正状态的版本。
- [兼容性检查](compatibility.json)记录初次审查头；[合并记录](merge.json)记录最终主分支头、合并树和未提交文档的备份位置。没有推送或部署。

## 合并后回归

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过，包含应用与 control 类型检查；[日志](build.log) |
| `npm test` | 711 项：710 通过、0 失败、1 项因指定 DSH 未安装而跳过；[日志](test.log) |
| 架构关键回归 | 完整测试包含实际 React 页面中的后台审批恢复、run.error 清等待、卸载只关闭订阅、群聊后续回合标题刷新，以及设置读取/保存竞态 |
| `RAYTONEBOT_URL=http://127.0.0.1:5196 npm run check:local` | 通过；[日志](local-check.log) |
| `node scripts/cloud-preview.mjs --check` | 通过；[日志](cloud-check.log) |
| 普通页面与开发场景 | 普通欢迎页无开发控件；390px 欢迎页与 19 个事件场景全部渲染，无页面横向溢出，诊断默认折叠；[逐项记录](fixtures.json) |
| 设置交互 | 桌面切 390px 和中/英/日语言切换后，当前分类均可见；[记录](browser-review.json)、[截图](settings-mobile.jpg) |
| 浏览器控制台 | 检查时段无 warn/error；同上记录 |

## 回归发现及补修

桌面展开错误详情时，标题、说明与详情横排在同一行。根因是 `src/main.tsx` 后导入的 `agentmatrix.css` 将 `.error-item` 从 grid 覆盖为 `flex-wrap`；之前的窄屏检查被自动换行掩盖。此规则在两边分支共同基线中已经存在，不是架构合并造成的冲突。

由原样式子代理仅修改该处规则为图标与正文两列网格，主代理复核：标题、说明、details/small 逐行位于第二列，原图标、主题字重及原生详情焦点保持。

- [修复前几何](desktop-error-before.json)与[截图](desktop-error-before.jpg)：三个正文子项 y 均为 104.5。
- [修复后几何](desktop-error-after.json)：正文 y=125.40，详情 y=149.52，均在上一行之后且左侧对齐。
- 修正后再次构建和 8 项错误呈现/导航回归通过；[构建日志](build-after-layout.log)、[定向测试](targeted-after-layout.log)。完整测试在此 CSS 修正前执行，未重复完整套件。
- 普通错误、Retrying、Exhausted、Terminal 四场景分别在 1280×720 和 390×844 检查，8 组布局断言全部通过；[记录](error-layout-regression.json)。原生键盘展开与诊断展开可同时工作，无横溢出。
- [最终桌面错误与诊断](error-and-debug-desktop.jpg)、[窄屏错误与诊断](error-and-debug-mobile.jpg)、[窄屏终态](terminal-mobile.jpg)。

验证使用主工作区源码、独立临时数据和 5196 端口，不使用用户真实会话、凭据或外部模型。没有真实模型调用、手机触摸、完整读屏或云端部署验收。构建保留已有 Vite 原生配置导入提示和大 chunk 提示。
