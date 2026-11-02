# PR #2 验收附件

2026-11-02。对应已验收源码 `72487e851bb466e1fb48082d1792e4ef7e1f78b3`。为便于代码 review，仓库保留 25 份验收摘要、结果索引及复跑脚本；149 份原始日志、截图和完整打包清单移至 GitHub 验收附件。完整归档仍包含原有 174 份证据。

- [下载完整 ZIP](https://github.com/raytoneai/raytonebot/releases/download/observer-review-evidence-2026-11-02/observer-review-evidence-2026-11-02.zip)
- [下载 SHA-256 校验文件](https://github.com/raytoneai/raytonebot/releases/download/observer-review-evidence-2026-11-02/observer-review-evidence-2026-11-02.zip.sha256)
- [附件说明页](https://github.com/raytoneai/raytonebot/releases/tag/observer-review-evidence-2026-11-02)

ZIP 大小为 10,355,763 字节，SHA-256：

```text
55a6eecc6f0f1632b87b7dfb87c89a97a3dfc0b50504016ed9b00639ede0eca0
```

下载两个文件到同一目录后，可用 `shasum -a 256 -c observer-review-evidence-2026-11-02.zip.sha256` 校验，再解压到独立目录。归档保留 `output/` 下的原始相对路径，`ARCHIVE.json` 列出每个文件的 SHA-256、大小、来源提交和脱敏记录。

两个历史失败日志的四处本机工作区前缀已替换为 `<repo>`；测试结果、时间与错误内容未改。此整理不重写此前已推送的 Git 历史；旧提交中的原始路径仍可能存在。归档标为验收资料，不设为最新应用版本。

## 索引与验证范围

- [运行来源、只读讨论与例行报告三批验收](dsh-review-fixes-2026-11-02/README.md)
- [Observer 核心验收](observer-2026-11-02/README.md)
- [实施/效果记录与认证脚本补齐](observer-followup-2026-11-02/README.md)

954 项、953 通过、1 项 DSH 跳过是具备 Chromium 的本机结果。在同一源码显式禁用 Chromium 后，已复现 876 项、848 通过、28 跳过、0 失败：被跳过的浏览器父测试不会注册其子测试，因此总数不同。该复核使用本机 Node 26，不冒称复验了远端 Node 24 环境。

本次仅整理证据及部署说明；运行时代码、依赖和模型配置不变。真实模型收益与逐平台部署仍按原记录保留未验状态。
