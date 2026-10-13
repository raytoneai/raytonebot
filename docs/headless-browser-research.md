# 沙箱内无头浏览器选型调研（2026-10-13，第二版）

目的：为路线图里的「浏览器接管」（Output 面板的一个来源，只在可见时连接）选一个装进 AgentSphere 沙箱的浏览器。要求：Agent 能操作；用户能实时看、能接管（例如登录）、能交还。只做调研，没有改产品代码。

## 0. 用户的决定（2026-10-13）

1. 只接管浏览器视口，不做整台桌面。真实运行环境是 AgentSphere 沙箱。
2. 登录态（profile/cookie）与其他 bot 数据同等对待：纳入 `backup_data.py`，可以恢复到新实例。
3. 只读的浏览器动作不需要审批。
4. 允许下载；部分危险操作弹出审批（分类见第 4 节）。
5. 要求再找有没有比「Playwright + Chromium headless shell」更轻、又能渲染像素的方案（见第 1、2 节）。

约束：
- 模板 `agentmatrix-v1`：2C/4G，x86_64，Ubuntu 22.04（由 fd 8.3.1 推断），Node 24（`06-deployment-runbook.md`）。
- nftables 只有原生 `ip`/`ip6` 表，按 UID 写规则（`setup_isolation.py`）。
- 内存里已经有主机加最多 3 个并行对话的引擎进程，浏览器预算大约 0.5–1 GB。

## 1. 实测：引擎与驱动的体积和内存

**测量方法**：
- 环境：本机 macOS arm64，Playwright 1.64 / CfT 156。
- 流程：视口 1280×800。先空闲 3 秒；再打开 en.wikipedia「Web browser」；再打开 github.com/microsoft/playwright。之后边滚动边做 10 秒 screencast，参数 1024×640、q60。
- 统计：内存是浏览器整棵进程树 RSS 之和，共享页会被重复计入，**只能横向比较，不等于 Linux 沙箱里的数值**。
- Linux 体积：用下载头 Content-Length 测量，并解压实测。
- 标注：凡写「报告」的，是项目方或第三方数据。

| 方案 | Linux 体积（实测） | 空闲 / Wiki / GitHub RSS（实测，mac） | 10 秒 screencast（实测） | 画面质量 |
|---|---|---|---|---|
| **chrome-headless-shell**（CfT 156，Playwright 默认无头） | zip 126 MB，解压约 283 MB | **248 / 377 / 543 MB**，4 个进程 | 199 帧，平均 31 KB，CPU 1.8 s | 与 Chrome 一致 |
| 同上 + 低内存参数（`--renderer-process-limit=1`、关站点隔离、`--js-flags=--max-old-space-size=256` 等） | 同上 | 249 / 375 / 596 MB | 190 帧，CPU 1.8 s | 同上；单页场景没有收益 |
| 完整 Chrome `--headless=new` | zip 200 MB | 991 / 1167 / 1603 MB，10–11 个进程 | 192 帧 | 同上；mac 上多出 GPU/工具进程，是 shell 的 3–4 倍 |
| 同上 + 低内存参数 | 同上 | 821 / 965 / 1290 MB | 190 帧 | 同上 |
| Firefox 157（Playwright，Juggler 协议） | zip 116 MB，解压 317 MB | 942 / 1087 / 1221 MB | 228 帧，41 KB | 好；比 shell 重 |
| WebKit 27.2（Playwright 的 Linux 构建） | zip 108 MB，解压 293 MB；依赖 GStreamer 等 | 没测成：mac 版用 XPC 服务，进程树统计不到 | — | Linux 上部分登录站点兼容性较差（报告） |
| Obscura 0.2.4（Rust + V8，自带 CDP 和渲染） | 完整版 tgz 71 MB（无渲染版 43 MB） | **29 MB** / 194 MB / GitHub 30 秒超时 | 12 帧 | GitHub 页面**完全没有样式**（截图可见），不能用来登录接管 |
| Lightpanda 1.0（Zig + V8） | 单文件 188 MB；deb 36 MB | 23 MB；经 Playwright 打开页面超时，截图报错 | 0 帧 | 不渲染像素（官方说明） |
| Servo 0.7.0 / Ladybird | Servo linux tgz 49 MB | 未测 | — | Servo 月更但没有宣称可用于生产；Ladybird 2026 年仍是 pre-alpha（报告） |
| WPE WebKit（Cog 已标为 legacy） | Ubuntu 22.04 没有新版包 | 未测 | — | 主打嵌入式、低内存，但内存随时间增长的反馈不少（报告） |

**驱动层**（这部分常驻 bot 进程或独立进程，与浏览器无关）：

| 驱动 | 包体积 | 常驻内存增量（实测，mac） |
|---|---|---|
| 自写 CDP 客户端（Node 自带 WebSocket，取 `Accessibility.getFullAXTree`） | 约 0 | **+1 MB** |
| puppeteer-core 25.13 | 8 MB | 仅 import 就 +33 MB |
| playwright-core 1.64 | 14 MB | 仅 import 就 **+96 MB**（堆 41 MB） |
| agent-browser 0.39（Rust 守护进程） | 18 MB 二进制 | **守护进程 20 MB**；用的 Chrome 就是上面的 shell，进程树同样约 550 MB |

**结论**：
- **引擎层没有更轻、又能可靠显示真实网站的选择。** chrome-headless-shell 已经是能正常渲染的方案里最轻的，比 new headless 和 Firefox 都轻 2–4 倍。Obscura、Lightpanda 很轻，但样式缺失或根本没有像素，无法满足「用户看着登录」。
- **驱动层可以明显减重。** 把 Playwright 从 bot 进程里拿掉，常驻内存能省约 80–95 MB，可选 agent-browser（20 MB）或自写 CDP。
- 低内存参数在单页场景没有收益。真正有效的是：只开 1 个浏览器、少开标签页、空闲后关闭，再加 cgroup 或 `prlimit` 兜底。

## 2. 修订后的推荐

**首选：chrome-headless-shell + agent-browser（Apache-2.0）**
- 运行方式：守护进程以 `raytone-browser` UID 运行；bot 通过 `sudo -n -u raytone-browser agent-browser … --json` 调用。
- 优点：
  - 守护进程常驻约 20 MB，用 Rust 实现，bot 进程不需要加载 Playwright。
  - 自带可访问性快照与 `@eN` 引用、`--download-path`、`--profile <dir>` 持久化、`--proxy`。
  - 带 WebSocket 实时画面：JPEG 帧，支持 seq/ack 节流，并接收鼠标、键盘、触控输入。这正好是“看 + 接管”需要的。本机实测可以直接指定 Playwright 的 headless shell 作为浏览器。
  - 由守护进程自己启动 Chrome，避免了 Playwright `launch()` 不能切换 UID 的问题。
- 代价：
  - 0.x 版本，每周都发版。部署时要锁定版本并校验 SHA-256，做法同 fd。
  - 安全功能都需要手动开启。
  - stream 端口在 loopback 上没有鉴权。Agent UID 已被 nft 挡住，不能访问 loopback；其他 UID 能访问，依赖“沙箱里只有 bot”这个前提。

**备选：chrome-headless-shell + playwright-core，放在按需启动的独立 worker 进程里（以 `raytone-browser` UID 运行）**
- 适用：agent-browser 变动太快时，或者需要微软维护的稳定 API 时。
- 能力：`ariaSnapshot({mode:"ai"})`、`page.screencast.start({onFrame})`、下载事件，都是 1.59 以后的稳定 API。
- 内存：worker 只在浏览器使用期间存在，约 +150 MB（Node 约 60 MB + Playwright 约 96 MB），不常驻 bot。
- 先例：OpenBot 的 agent-computer 和 OpenMuse 的 worker 都是“独立的 Playwright 进程 + CDP screencast”这种结构。

不选：
- 自写 CDP 最轻，但 AI 快照、引用、自动等待都得自己写和维护。
- Obscura、Lightpanda：画面不可用（实测）。
- Firefox、WebKit：更重，或兼容性更差。
- Servo、Ladybird：尚不成熟。
- Steel、neko、noVNC：需要 Docker、UDP 或整个桌面，已被决定 1 排除。

## 3. 安全模型（沿用第一版，补充备份）

- **出站**：
  - `raytone-browser` 的 nft 规则只允许访问 bot 的 loopback CONNECT 代理端口，其余全部 drop。
  - 代理在连接时用 `isPublicAddress` 检查目标并直连已检查的 IP，只允许 80/443。
  - Chrome 参数：`--proxy-server`、`--proxy-bypass-list=<-loopback>`、`--disable-quic`、`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`。
  - 效果：元数据 IP 和沙箱内部端口都访问不到。OpenMuse 用的是同样的代理，但它没有内核层的兜底。
- **Agent 进程不直接接触浏览器**：只通过 bot 的工具调用。CDP 端口、stream 端口、profile 目录对 Agent UID 都不可达。
- **profile 备份**（决定 2）：
  - 在 `DATA_PATHS` 中加入 `/home/raytone-browser/profile`，排除 `Cache`、`Code Cache`、`GPUCache`、`Service Worker/CacheStorage`。
  - 备份前先停止浏览器，或让它 flush，做法同现有的停止 CLI 进程。
  - 启动参数加 `--password-store=basic`：Linux 上 cookie 用固定密钥加密，所以能在新实例上解开。
  - 风险：备份包从此包含网站登录态。备份包本来就含 IM 凭据，保管要求不变，但要在 `issue.md` 写明。
- **用户密码只走接管**：
  - Agent 不读、不填密码，不导出 cookie。
  - 参照：Operator 的 takeover mode；OpenBot 的 sign-in 工具（“You never see the username, password or code”）；agent-browser 的 auth vault。

## 4. 下载与危险操作

### 4.1 先例

| 项目 | 下载 | 被视为危险并拦截的动作 | 怎么确认 |
|---|---|---|---|
| CopilotKit OpenBot（MIT） | 工作区文件下载上限 100 MiB；下载算单独的 intent，先审计再取字节，以附件返回 | 策略（CEL）按服务端快照解析出的元素 role/name 判定，不信模型自报的标签；把点击、Enter、`type` 带 submit 都归为 `activate`；`activate/type/write_file/run_command` 算写操作，进入审批闸门 | 统一的审批与审计记录；接管和登录走单独的请求 |
| CopilotKit OpenMuse（MIT） | 只收 PDF：每个会话 20 个、每个 ≤10 MiB；检查 `%PDF-` 文件头和实际字节数；超限中途取消 | 浏览器只读（read_web）；预订类交互要求用户接管；发邮件、改日程走 prepare_* 再单独审批；提示词禁止 send/post/submit/sign-in/buy/upload | 审批卡片 + 接管 |
| agent-browser | `--download-path` | 动作分类：navigate/click/fill/eval/download/upload/state/network…；文档把 eval、download、upload 列为危险 | `--confirm-actions` 返回 `confirmation_required` 和 id，由编排方 confirm 或 deny；60 秒不回应自动拒绝 |
| Playwright MCP | 输出目录，按大小淘汰旧文件 | 每个工具标注是否只读；`browser_run_code_unsafe`“等同 RCE”；上传只限工作区路径；官方声明“not a security boundary” | 交给客户端审批 |
| browser-use | `accept_downloads=True`，`downloads_path`，PDF 自动下载 | `allowed_domains` / `prohibited_domains`、`sensitive_data` | 开源版没有人工确认机制 |
| Steel | 下载进会话 VM 的 `/files`，经 Files API 取回；会话结束后转入全局存储 | — | — |
| Anthropic computer use | — | 有现实后果的决定和需要明确同意的事项，例如接受 cookie、完成支付、同意服务条款；建议域名白名单 | 人工确认要在**每个动作执行前**做，因为一轮里可能有多个动作 |
| OpenAI Operator / CUA | — | 完成购买、发送邮件等“改变外部状态”的最终动作；登录和支付信息改由用户接管；邮箱、银行等敏感站点启用 Watch Mode | 模型主动询问，系统卡片报告召回率 92%；新版指南写的是“purchases, data transmission（在表单里输入敏感信息也算）, destructive changes” |
| OpenHands | — | 风险分 LOW/MEDIUM/HIGH/UNKNOWN，UNKNOWN 默认要确认；“网络访问、数据外泄”算 HIGH | `ConfirmRisky` 阈值；拒绝时附上原因让 Agent 换方案 |
| nightly openbot（非商业许可，只参考设计） | — | 预览版对动作不逐个确认；登录、秘密问题交给接管 | 接管与审批在 app 内显示 |

杀毒扫描：ClamAV 官方建议 3 GiB 以上内存，签名库常驻约 1.2–1.6 GB，更新时还会翻倍，4G 沙箱装不下。只能靠类型白名单、文件头检查、去掉可执行位、限制大小。

### 4.2 RaytoneBot 分类提案

沿用 `permissionPolicy.ts` 的类别和三种模式（请求权限 / 替我批准 / 全部允许），不新增类别。分类在 bot 内完成，依据**最近一次服务端快照里的元素**（role、name、type、所在 form 的 method），不采信 Agent 给出的描述，这一条照搬 OpenBot。Enter、Space 和 `type` 带 submit 都按“激活”处理。

| 类别 | 浏览器动作 | 请求权限 | 替我批准（沙箱默认） | 全部允许 |
|---|---|---|---|---|
| `read` | 打开或跳转到公网 URL、快照、截图、滚动、hover、前进后退、标签页、等待、读文本 | 直接执行 | 直接执行 | 直接执行 |
| `mutating` | 普通点击和输入（搜索框、展开菜单、翻页、筛选）；GET 搜索表单提交；关闭 cookie 横幅；**普通下载**（文档、图片、表格、压缩包、媒体，单个 ≤100 MiB，会话累计 ≤500 MiB）进入工作区 `downloads/` | 询问（可「始终允许」） | 直接执行 | 直接执行 |
| `connector` | 在用户已通过接管登录的站点上做任何写类动作（参照 Operator 的 Watch Mode）；可以按站点记住「始终允许」 | 询问 | 询问 | 直接执行 |
| `outward` | **有外部后果的激活**：POST 表单提交；按钮名或文字匹配 send/post/publish/submit/pay/buy/order/checkout/confirm/delete/unsubscribe/agree/accept terms，以及 发送/发布/提交/支付/购买/下单/确认/删除/注销/同意；在浏览器里**上传**工作区文件；接受 `confirm()` 类对话框；**可执行文件下载**（ELF、PE、Mach-O 文件头，或 .sh/.deb/.rpm/.AppImage/.apk/.jar/.exe/.msi/.dmg/.pkg）；超出大小上限的下载 | 询问 | 询问（不能「始终允许」） | 直接执行 |
| `secret` | 往 password、OTP 或 `autocomplete=cc-*` 字段输入；读取或导出 cookie、storage、profile；执行任意 JS | 拒绝，并提示改用接管 | 拒绝 | 拒绝 |
| 接管请求 | `browser_request_takeover(reason)`：登录、验证码、支付信息 | 用 `approval.tsx` 的提问卡片；用户输入不进记录，交还后 Agent 重新取快照 | 同左 | 同左 |

下载流程：
1. Chrome 用 `Browser.setDownloadBehavior` 下载到 `raytone-browser` 自己的隔离目录。
2. bot 监听 `downloadWillBegin` / `downloadProgress`，超限就调用 `Browser.cancelDownload`。
3. 下载完成后检查文件头、大小，清理文件名。
4. 按上表分类：`mutating` 直接复制进工作区 `downloads/`，权限 0660、去掉 x 位；`outward` 审批通过后再复制。
5. 在 Output 面板按现有文件预览显示；被拒绝的结果写进工具结果。

与现有表格的差异：外部可达，是因为浏览器真的能访问公网（Agent 的 `curl` 上传在沙箱里会被防火墙挡下），所以浏览器上传和提交归为 `outward`，在沙箱里**也会询问**。

## 5. 集成草图（首选）

```
src/pi/browser/
  egressProxy.ts    # loopback CONNECT 代理，复用 isPublicAddress，只允许 80/443
  browserHost.ts    # sudo -u raytone-browser 启动或停止 agent-browser 守护进程（--profile、--download-path、--proxy、
                    # 锁定 --executable-path 到 headless shell）；空闲 10 分钟关闭；同时只有一个会话
  browserTools.ts   # BROWSER_TOOL_SPECS（同 WEB_TOOL_SPECS），经 ADR-034 的三条路径交给三引擎；
                    # 每次调用前按 4.2 分类，再经 approvalGate；调用 CLI --json
  browserPolicy.ts  # 4.2 的规则（输入为快照元素和动作），配单元测试；agent-browser --action-policy 另外 deny eval/state/network
  browserStream.ts  # 只在前端订阅时连接 stream ws（?pacing=ack&maxFps=8），转成鉴权的 SSE；输入走 POST，只在 holder=human 时转发
路由：GET /__agentcanvas/pi/browser/stream · POST …/browser/input · POST …/browser/control（02-architecture 登记）
前端：outputframe/ 增加 browser 来源（卡片低频取帧，展开后订阅）；接管/交还复用 approval.tsx；?devtools=1 fixture
部署：deploy.py 锁定 agent-browser 与 headless shell 的版本和 SHA-256，安装 libnss3 等依赖与 fonts-noto-cjk；
      setup_isolation.py 新建 raytone-browser 并加 nft 规则；backup_data.py 加入 profile（排除缓存）
```

## 6. 下一步与仍需确认的事项

PoC（都要在**真实 AgentSphere 沙箱**里测，本文的内存数据来自 macOS）：
1. headless shell 空闲和打开 3 个常见网站时的 RSS；与一个引擎同时运行时是否 OOM。
2. Chrome 的 user namespace 沙箱能否启用。
3. 以 `raytone-browser` 访问 `127.0.0.1:<应用端口>`、`169.254.169.254`、内网 IP、DNS 重绑定域名，都应失败。
4. 帧经云端网关的延迟，以及面板关闭后是否停止推流。
5. 备份恢复到新实例后登录态是否仍有效。
6. agent-browser 由点击触发的下载能否进入 `--download-path`，`--json` 输出是否稳定。

需要用户确认：
1. 关闭 cookie 横幅归 `mutating` 还是 `outward`？Anthropic 的指南把“接受 cookie”列为需要确认。
2. 下载上限是否采用每个 100 MiB、会话累计 500 MiB？磁盘配额还没查（`sandbox.py status` 的 `diskSizeMB`）。
3. 首选 agent-browser（更轻，但上游变化快），还是备选 Playwright worker（更稳，使用时多占约 150 MB）？

## 来源

- 版本与体积：npm、PyPI、GitHub API 及 CDN Content-Length，2026-10-13 查询；内存为本机实测，脚本放在 `/tmp/hb/measure.mjs`，不在仓库内。
- Playwright 版本说明 / 浏览器安装 / Screencast / ariaSnapshot：https://playwright.dev/docs/release-notes ，https://playwright.dev/docs/browsers ，https://playwright.dev/docs/api/class-screencast ，https://playwright.dev/docs/api/class-locator#locator-aria-snapshot
- Chrome headless shell：https://developer.chrome.com/blog/chrome-headless-shell ；CfT：https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json ；CDP：https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast ，https://chromedevtools.github.io/devtools-protocol/tot/Browser/
- agent-browser：https://github.com/vercel-labs/agent-browser （Streaming、Security），https://agent-browser.dev/security
- Obscura：https://github.com/h4ckf0r0day/obscura ；Lightpanda：https://lightpanda.io/blog/posts/lightpanda-1-0 ，https://github.com/lightpanda-io/browser ；Servo：https://servo.org/blog/ ；Ladybird：https://ladybird.org/ ；WPE FAQ：https://wpewebkit.org/about/faq.html ；Cloudflare Kitesurf（未开源）：https://blog.cloudflare.com/kitesurf/
- OpenBot：https://github.com/CopilotKit/OpenBot （`server/src/computer/policy.ts`、`gateway.ts`、`agent-computer/src/screencast.ts`、`workspace.ts`，6d86ba4）
- OpenMuse：https://github.com/CopilotKit/openmuse ，https://github.com/CopilotKit/openmuse/blob/main/apps/worker/README.md
- Playwright MCP：https://github.com/microsoft/playwright-mcp ；browser-use：https://docs.browser-use.com/customize/browser/all-parameters ；Steel Files API：https://docs.steel.dev/overview/files-api/overview
- Anthropic computer use：https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool ；OpenAI computer use：https://developers.openai.com/api/docs/guides/tools-computer-use ；Operator 系统卡片：https://cdn.openai.com/operator_system_card.pdf
- OpenHands 安全：https://docs.openhands.dev/sdk/guides/security ；nightly openbot：https://github.com/nightly-labs/openbot
- ClamAV 内存：https://docs.clamav.net/manual/Installing/Docker.html ，https://wiki.archlinux.org/title/ClamAV
