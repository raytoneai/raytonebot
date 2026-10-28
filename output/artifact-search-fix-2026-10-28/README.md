# 产物搜索框重叠修复 · 2026-10-28

原因：产物搜索复用了 `.workspace-search-field` 的绝对定位图标，但独立 input 样式把左右 padding 都设为 0，文字从图标左侧开始绘制。

修复：把 `.output-artifact-search input` 与清除按钮纳入现有工作区搜索框的共用样式；这些规则覆盖产物 input 的早期 reset。提交前改为 CSS 选择器复用，使修复不依赖尚未提交的产物管理功能实现。恢复搜索框边框、焦点样式和 32px 左侧留白；有清除按钮时预留 38px 右侧空间。

验证：
- 修复前手机视口中，文字起点相对图标右边界为 -24px，见 before.json / before.png。
- 修复后间隔 8.5px；长文字到清除按钮保留 10.5px，见 after.json。
- 390×844 触屏模拟与 1280×800 桌面检查无横向溢出；触屏输入框 44px，见 viewports.json、mobile.png、typed-mobile.png、desktop.png。
- 实际输入长中文、点击清除，输入值清空且焦点回到搜索框。构建通过；全部 20 个内置场景检查，无 console error，见 build.log 和 fixtures.json。
- 使用隔离测试服务和临时数据，无模型调用；用户 5188 服务保留运行并热更新。以上为提交前验收；未部署或推送。
