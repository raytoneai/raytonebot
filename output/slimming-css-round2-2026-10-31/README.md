# app.css 第二轮清理（2026-10-31）

基线 `0d8faf6`。快速子代理实现，主代理复核引用、CSS AST、注释语义和浏览器结果。源码仅改 `src/styles/app.css`；没有修改组件、会话/流式状态机、vendor 或依赖。

## 清理结果

| 项目 | 清理前 | 清理后 |
| --- | ---: | ---: |
| app.css 行数（wc -l） | 11,330 | 9,624 |
| app.css 字节 | 306,415 | 267,008 |
| 注释数量 | 154 | 132 |
| 注释正文 UTF-8 字节 | 21,855 | 16,101 |
| 主 CSS 构建产物字节 | 287,270 | 259,238 |
| 同一 Node gzip 算法压缩字节 | 45,011 | 41,055 |

删除 205 条规则、5 个无引用 keyframes，以及删除后为空的 1 个 reduced-motion 媒体查询。注释删除 22 条（其中 7 条在删除规则内部），精简 10 段，另移除一处历史变更句。保留审批与 composer 的位置/宽度关系、侧栏负 margin 防重排、visibility 维护焦点顺序等原因。

删除范围为旧配置器、导航/骨架/手风琴、旧模型服务与 Agent 选择、旧审批步进器、命令菜单、Git 状态和 harness 导入控件。通用 primary/secondary/text-control、复杂及含活跃分支的混合选择器、生成内容与第三方渲染相关样式保留。没有重排、合并保留规则或更改声明。

## 独立 review

- [子代理审计](worker-audit.json)：组件族归属、模板/拼接/classList 动态类名、动画、注释和保留边界。初始子串扫描 178 条，精确 token 扫描 207 条；加上同族 compound wrapper 规则并排除保留项，最终批准 205 条。
- [批准清单](approved-removals.json)在改动前冻结。主代理另扫 1,494 个应用、vendor 和相关渲染依赖文件，确认每个删除选择器分支至少依赖一个未出现的完整 class token，共 104 个：[引用复核](reference-review.json)。动态产出风险按组件族人工核对，不能只凭搜索零命中删除。
- `node output/slimming-css-round2-2026-10-31/review.mjs`：从 Git 读取基线并仅移除批准节点，与当前完整 CSS AST 比较。保留选择器、声明、顺序及 at-rule 上下文完全一致；忽略注释/空白及清空的 at-rule。[脚本](review.mjs)、[结果](review.json)。
- [构建体积](bundle-review.json)：主 CSS 减少 28,032 bytes，gzip 减少 3,956 bytes；其余 CSS chunk 不变。

## 验证

- `npm run build`：基线与清理后均通过。[基线日志](baseline-build.log)、[清理后日志](build.log)。
- `npm test`：默认并发 650/650，通过、无跳过，17.49 秒。[完整日志](tests.log)。浏览器 UI 操作在该命令结束后开始，未与 Chromium 测试并行。
- IAB + 隔离的本机 Vite/数据/工作区：1280 × 800 欢迎页及模型服务展开；390 × 844 其余设置分区、亮暗主题切换、欢迎页和全部 19 个事件场景。各窄屏记录均为文档宽度 390，没有横向溢出。[状态记录](ui-results.json)。
- 实际打开 `compare-plans.html`，加载本机临时 HTML 后在现有 Output 弹层展示内容。[浏览器 warn/error](browser-logs.json)为空。
- 开始的场景菜单曾在跨调用后关闭，重新读取实际状态后重新打开并完成全部场景。HTML fixture 不自行写文件；首次打开显示缺文件提示，在隔离的 assistant/builder 工作区补齐同一个无脚本测试文件后重新加载成功。这些是验证准备过程，没有据此修改产品代码。
- `git diff --check` 通过。未调用真实模型、外部 Provider、远端部署；没有进行像素级差异断言，也未另做系统 reduced-motion 模拟，其保留规则由 AST 等价核对覆盖。

## 截图

| 场景 | 清理前 | 清理后 |
| --- | --- | --- |
| 桌面欢迎页 | [截图](before-welcome.png) | [截图](after-welcome.png) |
| 模型服务 | [截图](before-settings.png) | [截图](after-settings.png) / [展开](after-provider-expanded.png) |
| 窄屏审批 | [截图](before-approval.png) | [截图](after-approval.png) |
| 窄屏 HTML 预览 | [截图](before-output.png) | [截图](after-output.png) |

另有[群聊](after-group.png)、[错误](after-error.png)、[重试](after-retry.png)、[暗色设置](after-dark-settings.png)。前后选中 Bot 不同，比较对象为布局和样式，未将头像差异视为 CSS 变化。
