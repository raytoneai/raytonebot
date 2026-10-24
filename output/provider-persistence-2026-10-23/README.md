# Provider 持久化验收

2026-10-23，本机代码；未部署、未推送。

## 结果

- 保存同一个原子配置：主机持有配置、revision 和 endpoint 绑定的密钥。AES-256-GCM，目录 0700、文件 0600；默认随机 master.key，支持稳定部署环境主密钥。页面不返回明文或片段，保存后清空输入。
- 刷新和 Node 主机重启后恢复；密钥替换、留空保留、删除、撤销、旧版本冲突、损坏文件保护及秘密环境剥离均有覆盖。
- 官方 Google endpoint 的 store 兼容修复保留。此次重点是持久化，不把模型列表可访问或虚拟 key 测试当成真实推理成功。

## 验证

- `npm test`：466/466 通过。
- 最后私密目录排除补齐后，provider store、Pi host、权限与 workspace 相关 53/53 通过。
- `npm run build`、`npm run check:local`、`node scripts/cloud-preview.mjs --check` 通过。构建既有 chunk 大小提示仍在。
- AgentSphere Python 测试：19 通过，3 环境相关跳过。
- 真实 HTTP 隔离测试：保存、关闭并新建 host、GET 不泄密、新会话 configure 收到保存的虚拟 key、换 URL 不发送旧 key、删除后新轮次 clearApiKey、跨源 403、过期 revision 409、no-store。
- UI 使用独立 5199 服务和 `/tmp/raytonebot-provider-ui-check/` 数据，输入虚拟 key，验证保存后输入清空、刷新及 Vite host 重启后显示“已保存在主机”；显式删除先显示“待删除”，撤销恢复无未保存更改，提交删除显示缺少密钥。测试 key 已删除，没有发送到供应商。
- `?devtools=1` 从欢迎页逐项切换另外 19 个内置场景（含思考、审批、错误、产物、中断、重试、耗尽、终止），入口均能渲染。部分 AX 状态记录在 fixtures.json；本轮未重新做全场景逐像素对比。
- 截图 `saved-after-restart.png` 为隔离服务使用虚拟 key 的持久化状态，`deleted.png` 为删除后状态。
- 本次相关路径 `git diff --check` 通过；全仓库另有既存 avatar 临时文件尾空格，未改动。

## 限制

- 用户 5188 页面的新主机库仍未保存真实凭据（验收时 revision=0）；旧内存 key 无法从脱敏密码框恢复。已请用户在新版设置显式保存一次，收到“已保存在主机”后可继续验证真实 Gemini。
- 真实 hello 本轮仍没有成功回复，不能宣称推理已恢复；详见 Gemini 400 记录。
- 未验证线上暂停恢复/独立 UID。普通数据备份不含同级私密目录；销毁重建须恢复密文与匹配主密钥。未实现跨实例自动秘密备份或 Keychain。
- 默认主密钥与密文位于同一受保护目录，不能抵御复制整个目录或控制主机 UID；加密与权限隔离的范围见 docs/product/12-provider-credentials-proposal.md。
