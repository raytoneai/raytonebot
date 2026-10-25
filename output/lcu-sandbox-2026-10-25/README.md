# LCU sandbox 验证（2026-10-25）

用户授权验证 LCU 能否利用 sandbox 自带的 Codex。新建独立 AgentSphere 自动暂停实例 `ic62vgn5jrfwv4g9voz6o`，使用相同 `agentmatrix-v1` 模板；未唤醒或修改原浏览器测试实例、生产实例、本机个人 Chrome 或现有登录数据。

## 已验证结果

| 检查 | 结果与证据 |
| --- | --- |
| 模板实际环境 | Ubuntu 22.04.5、glibc 2.35、x86_64、Codex CLI 0.154.0、Node 24.18.0。没有桌面 app、Xvfb 或 Chromium。[preflight.json](preflight.json) |
| 仅依靠已有 Codex 安装 LCU | **失败，符合预期**。发行包 SHA-256 校验通过，安装器明确要求官方 ChatGPT app，CLI 不能代替它。[install-probe.json](install-probe.json) |
| 补入官方 app 后安装 | **通过**。官方 `.deb` 仅解包到测试目录，未启动账号登录；LCU 使用其原 runtime 安装到独立 prefix。[app-probe.json](app-probe.json) |
| 原生桌面运行时 | **通过**。补齐 Ubuntu 22.04 对应系统库、Xvfb/Openbox/D-Bus/bubblewrap 后，doctor 的窗口读取、截图和 JavaScript 沙箱检查均通过。[doctor-desktop.json](doctor-desktop.json) |
| Codex 注册 | **通过**。自带 0.154.0 接受 MCP 及 Stop/Interrupt/SubagentStop hooks，无需升级 CLI。[codex-setup.json](codex-setup.json) |
| MCP 协议与 JS | **通过**。初始化、工具发现、`cua.getState()`、`js_reset` 和进程正常退出。[mcp-desktop.json](mcp-desktop.json) |
| 浏览器操作 | **通过**。Chromium 加官方扩展、原 native-host relay，LCU 打开合成页面、读取 AX、输入并点击保存；独立 HTTP 服务收到精确 `LCU 中文验证 Café 2026`。[browser-session.json](browser-session.json) |
| 跨 origin iframe | **通过此合成用例**。父页 `127.0.0.1:8765`，iframe `127.0.0.1:8766`；通过 LCU `tab.playwright.frameLocator()` 填入并保存，独立服务收到 `LCU cross-origin frame`。不是所有生产网站 iframe 的兼容保证。 |
| 浏览器截图 | **通过**。LCU 工具返回真实 `image/jpeg`，31,387 字节；已取回并实看。[截图](browser-result.jpg) |
| 显式回合清理 | **通过**。发送 `turn_ended(Stop)` 后，再读旧 tab 得到“不属于该 browser session”，没有继续操作原页。仅证明此次显式 lifecycle 调用，不能替代所有中断路径验收。 |
| Codex 原生图片传输 | **通过**。模板自带 CLI 实际调用两次 LCU：打开空白 tab、截图；第三次模型请求携带 `input_image`，5,684 字节 JPEG 的 SHA-256 与 MCP 图片完全一致，CLI exit 0。模型端是本地脚本 Responses SSE fixture，没有真实推理。[结构化结果](codex-image-report.json)、[执行记录](codex-image-session.json) |

结论：已有 Codex 可复用作 LCU 调用端，原生 MCP 通道也能保留图片；需要额外补入桌面 runtime 和依赖。截图与跨域 iframe 比当前内置工具接口覆盖更宽，尚不能据此断言真实任务成功率或速度更好。RaytoneBot 的 HostTools 文本接口尚未改造，以上原生 CLI 结果不代表产品接入已完成。

## 固定版本与来源

- LCU：`0.13.0`，Linux x64 发行包 SHA-256 `9b6e71fa29d1fb86795aa8cee8d892444344c19fd9d2cd070c475551c49d7e34`。[官方 release](https://github.com/amontlabs/lcu/releases/tag/v0.13.0)
- ChatGPT：`26.1021.22027`；CUA：`0.0.35/20261022031940-486a6d3fcc3f`；官方包 SHA-256 `eb0831c734f154f93f8ebcf0e17d118da0dea7dc1737dc61a1e71444375bf190`。此组合不在 LCU 已测试版本表中，但本次上述路径真实通过。[官方下载说明](https://learn.chatgpt.com/docs/linux/linux-app)
- 浏览器：官方 app 所带 Playwright 安装的 Chromium `143.0.7499.4`，启用 Chromium 自带沙箱；没有 `--no-sandbox`。
- Chrome 扩展：从 Google 官方 CRX 服务取得，ID `hehggadaopoacecdllhhajmbjkdcmajg`，版本 `1.26.1020.11845`，CRX SHA-256 `328c3dc8230a8157c354f66068ee685fb55a56cf011d67880805c171967ad9fb`。校验 CRX 公钥对应 ID，保留原代码，仅为临时 unpacked fixture 在 manifest 中补公开 key；没有复制个人浏览器配置。
- 为 Chromium fixture 将 LCU 安装器生成的 Chrome native-host manifest 复制到 Chromium 对应目录。浏览器操作通过 LCU 完成，Playwright 仅负责启动独立 fixture 浏览器。

## 边界

- 新实例没有 Codex 模型登录；浏览器操作由协议测试脚本发起，不是真实模型自主规划任务。不修改产品所选模型，不复制任何模型或平台密钥到新实例。
- Codex 图片检查使用单次命令行 provider/model 覆盖和本地脚本端点，只控制测试中的两个工具调用，不更改产品默认模型。验证的是实际 CLI/MCP/图片请求传输，未验证模型能理解图片或自主完成网页任务。
- Ubuntu 22.04 不在 LCU 文档推荐范围，原安装脚本列的是 Ubuntu 24.04 的 t64 包名。本次手动安装同功能的 Jammy 系统库，未升级发行版、替换 glibc 或修改原 runtime。
- 合成页没有真实账号、验证码、支付或外部表单。扩展首次启动自行打开官方安装说明页；测试只控制 loopback fixture。
- 中文保存数据精确一致；截图中文字显示为方框，原因是这个最小模板没有 CJK 字体。这是部署依赖缺口，本次没有把字体缺失当成输入失败。
- 没有验证 RaytoneBot Output/审批/Vault 接入、真实账号登录、各引擎完整一致性，或与现有实现的成功率/耗时/token 横向基准。
- 初次 lifecycle 探针误用不存在的 `tab.getState()`，不作为清理证据；读取 runtime 返回的接口后改用 `getAXState()`，以上结论来自修正后的运行。
- 初次 Codex 探针继承了远端命令的未关闭 stdin，CLI 等待追加输入而超时；设置 `stdin=DEVNULL` 后完成上述传输检查。不是 LCU 或 Codex MCP 兼容失败。

## 收尾与占用

测试浏览器/WM/LCU 已退出；首次超时留下的单个 Xvfb 进程经过 PID 与完整命令行校验后终止，最终检查无相关活动进程或僵尸。[收尾检查](cleanup-inspect.json)

独立实例已暂停，平台 API 返回 `state: paused`；保留磁盘供后续检查，未继续运行。[最终状态](final-status.json)

测试提取的完整 app 为 1,671 MiB，LCU prefix 37 MiB，Playwright 浏览器包 612 MiB，扩展 4 MiB，合计约 2.3 GiB；不含 apt 系统库、下载包和缓存，也不是精简生产镜像体积。原实例和现有服务未修改。

## 复现与文件

此目录保留独立测试脚本和脱离秘密的执行结果。执行顺序为 preflight → install-probe → app-probe → desktop-deps → doctor-desktop → codex-setup → mcp-desktop → browser-install → browser-session → codex-image-session → cleanup。本机受信任运维入口使用既有 E2B SDK 1.x；平台凭据只在本机内存读取，远端只收到公开脚本。临时实例定位保留在被忽略的 `.agentsphere/lcu-trial-state/deployment.json`。

`extension-prepare.py` 的 CRX 处理和 `codex-image-probe.py` 的 SSE fixture 参考 LCU MIT 测试源码；许可见 [LCU-LICENSE.txt](LCU-LICENSE.txt)。不在此目录分发官方 app、CUA runtime 或扩展二进制。
