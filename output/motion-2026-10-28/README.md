# 手机与桌面网页动效 · 2026-10-28

## 本轮变化

- SettingsDialog、顶栏 Bot / 成员菜单：160ms 进入、120ms 退出，opacity + scale(0.98 → 1)，沿用现有 easing 与时长 token。Popover 使用 Radix 计算的触发点作为缩放原点，碰撞翻转后也适用。
- 用 CSS transition 保留中途反向的当前进度；只在 closed 时加空的 `surface-exit` CSS animation，为 Radix Presence 提供卸载时机。空动画不控制视觉属性，避免两套动画争用。减少动态效果时不缩放、不延迟卸载；不支持 `@starting-style` 的浏览器直接显示进入状态。
- 触屏发送、附件与侧栏按钮：60ms 压到 0.96、120ms 松开，禁用按钮和减少动态效果不缩放。搜索、权限/模型下拉维持即时响应。
- 聊天段落去掉整体位移入场；保留 WritingText 原本的流式文本逻辑。工作状态首次挂载不重播进入动画，停止时位移降到 3px，120ms 退出。
- 设置关闭后返回打开入口；手机抽屉关闭后仍回到可见侧栏按钮。静态顶栏头像和聊天标签简化不变。

## 实际验证

- `npm run build`：通过，已有 chunk size 提示；构建产物保留空 exit keyframes。
- `npm test`：592 项通过，无失败/跳过，详见 tests.log。
- 隔离开发服务 `127.0.0.1:5193`、临时数据/工作目录；未访问原 5188 会话或调用真实模型。
- 桌面 1131×720 与触屏模拟 390×844，亮/暗主题。设置进入/退出、Escape、关闭后的焦点返回、手机侧栏到设置再返回通过。
- 桌面和手机各切换全部 20 个内置 fixture：无横向页面溢出、无浏览器 console error。fixtures.json、mobile-fixtures.json 保留每项状态；PNG 为代表帧，不能单靠静态截图证明动效。
- popover-enter.json：捕获真实进入帧，opacity 0 → 1、scale 0.98 → 1，定位后 transform-origin 位于上边的触发位置。
- popover-reverse.json：关闭约 47ms 后再次打开，全程同一 DOM 节点，透明度从约 0.14 连续回升到 1，无消失后重新挂载。
- settings-exit.json：closed 后逐帧淡出，约 148ms 后卸载，无残留透明弹层；关闭完成后 body pointer-events 恢复 auto。
- activity-exit.json：状态提示淡出并移动至 3px，约 133ms 后移除。
- touch-press-style.json：触屏 media + 强制 :active 验证 scale 0.96、60ms；内置浏览器不支持合成 TouchEvent，未将此记录称为真机触控测试。
- 减少动态效果：菜单 scale/transition/animation 均为 none，关闭移除；标题头像子节点 animation-name 均为 none。相关临时调试探针、伪状态、视口与媒体模拟已清理。

## 复验步骤与限制

1. 打开顶栏菜单，快速反复开关；关闭到一半反向时不应跳回最小尺寸或闪烁。
2. 设置打开后用 Escape 关闭，应淡出后回到原按钮；手机从侧栏进入设置，关闭后回到侧栏展开按钮。
3. 系统开启“减少动态效果”，重复开关；不应残留透明层或发生缩放。
4. `?devtools=1` 切换事件流，工作头像预览选择思考再停止；文字段落应稳定，工作提示短退场。

本轮重点是常用设置面板、顶栏菜单、触屏反馈与聊天状态；没有增加页面跳转动画、客户端壳或改变工具折叠语义。Bot 编辑器由上层条件挂载，其取消关闭仍即时卸载。真实 iOS / Android 的帧率、浏览器系统手势、旧版本 Safari 和低端设备未实测，浏览器逐帧数据不等于真机性能基准。以上为提交前验收；未推送或部署。

## 提交范围复核

提交前将暂存区独立导出，排除其他任务尚未提交的 Bot/例行任务/产物目录功能，构建和 578 项测试通过，见 staged-build.log、staged-tests.log。完整工作区此前 592 项测试包含这些额外功能，因此数量不同。产物搜索修复以共用 CSS 选择器生效，保留独立可提交性；在完整工作区复验图标间隔 8.5px、清除按钮间隔 10.5px，见 ../artifact-search-fix-2026-10-28/commit-check.json。
