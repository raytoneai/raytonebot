# Provider 检查证据 · 2026-10-23

- 原页面复现：新增 Gemini 后打开默认模型，下拉在 AX 树中存在，但截图不可见；源码确认 dropdown=50、settings modal=110。
- 修复后：真实设置页模型菜单可见（model-dropdown-fixed.png）；隔离 SettingsDialog 选中 gemini-2.5-flash，获取 60 项不含该模型的列表后仍保持 flash，End → Enter 可选最后一项。
- 隔离 fixture：preview.html/preview.tsx 只挂载生产 SettingsDialog；所有请求为受控响应，无真实模型/密钥，无用户配置存储。slow=1 的 8 秒响应期间修改 Base URL，响应完成后仍是原两个候选、无过时成功状态。暗色截图 menu-dark.png。
- 20 个内置场景（含欢迎页）逐项切换，均渲染，无页面横向溢出，见 fixtures.json。没有重做各场景全部审批交互。
- 浏览器错误记录仅有编辑文件期间一次 Vite 热更新失败；最终重载、设置操作和内置场景未发现新的 error。
- node --test src/pi/providerProbe.test.ts：原 2 项通过，新增 3 项先失败；修复后 5 项通过。含 providerSettings 的 7 项窄回归通过。
- npm run build 通过（含 tsc；原有大 chunk 和 Vite configLoader 提示仍在）。完整 npm test 454/454、0 跳过，见 tests.log。
- check:local 与 cloud-preview --check 通过，见对应日志；未调用外部模型、未部署或推送。
- 浏览器临时启用的 Gemini 已恢复为禁用，真实默认服务仍为 DeepSeek/deepseek-flash；未读取/写入用户密钥、未发送原草稿。
- 密钥持久化仅形成 docs/product/12-provider-credentials-proposal.md 方案，未实现保存 API/凭据 store 或迁移已有秘密。系统钥匙串/云端主密钥/真实引擎协议需在落地阶段验证。
