# 主题收敛验收 · 2026-10-18

- 仅保留 Soft Glass（亮色，默认）和 Warm Graphite（暗色），颜色及字体与 HEAD 中原值逐项比较一致。
- `npm run build` 通过；`npm test` 405/405，通过日志见 `tests.log`；`git diff --check -- src docs/product` 通过。
- 浏览器设置仅两项；中文、英文、日文标签正常，切换和刷新后选中状态保留。
- 浏览器复验旧 `slate-blue` → `warm-graphite`、`sand-workspace` → `soft-glass`；迁移后的偏好写回存储。单测覆盖全部旧主题及损坏值。初次批量刷新读取发生在新页面挂载前，后续待页面稳定复验通过。
- 桌面与 390×844 设置截图见 `settings-*.png`；窄屏无横向溢出。
- 两种主题分别切换全部 19 个事件场景及欢迎页，聊天内容一致，控制台无 error/warn；快照和正文见 `fixture-checks.json`，截图见 `light-*.png` / `dark-*.png`。
- 只验证本机 UI 与回归测试；未调用真实模型、未部署。临时浏览器标签已关闭，中文/亮色及浏览器尺寸已恢复。
