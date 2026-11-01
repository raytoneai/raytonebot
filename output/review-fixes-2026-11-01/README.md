# 2026-11-01 整体审查分批修复

初始基线 `62e4e73`，后续第 7–13 项接续于文档提交 `c632404`，保留前六项未提交修改。用户要求保持最小改动，subagent 分批实现，主代理每批 review、验证通过后再继续。

| 批次 | 范围 | 结果 |
| --- | --- | --- |
| 1 | 同进程退出停止并等待活跃任务；bridge 初始化/清理拒绝收尾 | 已完成并通过主代理验证 |
| 2 | 记忆和 Skills 分类切换保留草稿；慢连接下例行任务刷新 | 已完成并通过主代理验证 |
| 3 | Output 展开时键盘进入/退出 HTML；普通问答等待暂停执行预算 | 已完成并通过主代理验证 |
| 4 | 权限撤销反馈、记忆完整快照冲突保护、日志隐私 | 已完成并通过主代理验证 |
| 5 | 前端运行所有权、组件样式所有权 | 已完成并通过主代理验证 |
| 6 | 外观键盘操作、权限页信息层级 | 已完成并通过主代理验证 |

各批均由 subagent 实现，主代理 review、验证通过后才进入下一批。检查使用临时数据、工作区和模拟引擎，不修改真实用户数据或调用真实模型。本轮未提交、推送或部署。前三批期间出现的并行文档修改保留，不计入当时六项修复范围。

## 第一批

- 产品变更：已有 `dispose()` 返回幂等完成 Promise，贯通 controller、群聊/委派、HTTP host 和 Vite；同步停止接收新任务，等待全部 stop、运行终态和会话操作后清理 bridge/gateway。缓存淘汰复用同一清理入口，失败只记录固定类别。
- 主代理 review：检查所有正式释放调用方、延迟 stop 注册、并发 abort 提前拒绝、缓存替换和初始化失败；没有引入新服务或通用生命周期框架。
- 新增 9 项回归；最初 7 项在修复前全部失败。最终相关组 111/111 通过。正常退出与未终态持久快照分别验证 `cancelled` / `interrupted`，两者均不重放。
- [最终构建](batch1-build-final.log)、[完整测试](batch1-test-final.log)：774 项，773 通过，1 项固定版本 DSH 未安装跳过，0 失败。[本机检查](batch1-local-final.log)、[云入口检查](batch1-cloud.log)通过。`git diff --check` 通过。
- [初次完整测试](batch1-test.log)唯一失败是旧 routine 测试把正常 dispose 当成崩溃；已保留两类语义的覆盖后复跑通过。
- 限制：Pi bridge 初始化和配置没有取消接口，退出仍等待已在途操作返回；未添加超时强杀机制。本批无 UI 改动，未重复视觉验收。

## 第二批

- 产品变更：SettingsDialog 仅把 Memory/Skills 两处条件卸载改为 native `hidden` 容器；局部编辑状态、来源日期和原始 `expectedText` 保留。关闭设置仍卸载这些编辑器，Vault/MCP 继续按分类卸载。useRoutines 加入带请求身份的读取锁，保留 3 秒刷新；写操作独占刷新，旧请求不能释放新请求的锁。
- 主代理 review：核对隐藏元素的布局和可聚焦性、关闭/重开、冲突后编辑状态、轮询与写入世代；目视桌面及 390px 记忆/Skill 截图。
- 红绿验证：原实现的 4 项草稿尺寸用例、4 项轮询回归先失败；修复后[草稿浏览器组 7/7](batch2-drafts-green.log)、[设置并发组 15/15](batch2-routines-green.log)通过。
- [构建](batch2-build.log)、[完整测试](batch2-test.log)通过：785 项，784 通过、1 项 DSH 环境跳过，0 失败。`git diff --check` 通过。
- [桌面/390px 场景结果](batch2-visual/fixture-results.json)：每个尺寸 20 个场景，40/40 通过；复用既有 `output/memory-improvements-2026-11-01/fixture-browser-check.mjs`，仅改证据输出目录。首次验证脚本误设 `ws:false` 导致 Vite 客户端连接报错；恢复原脚本 WebSocket 配置后复跑通过，[首次记录](batch2-visual/fixture-results-harness-error.json)保留。
- [窄屏记忆](batch2-visual/memory-draft-390.png)、[桌面 Skill](batch2-visual/skill-draft-1280.png)。本批无主机/HTTP 接口变化，未重复云入口策略检查。

## 第三批

- 产品变更：OutputFrame 在原面板两端放置不占布局的焦点哨兵，使用浏览器原生 Tab 顺序访问 iframe 和表单；首尾过滤隐藏/禁用/inert/负 tabindex，Escape 只处理当前面板，关闭后按当前焦点归还。controller 汇总审批与普通问答等待，在问题登记/清除时按当前 slot 更新原 deadline；不改 UserInputGate 接口或 Vault 期限。
- 主代理 review：核对 iframe 隔离、动态控件、直接子节点样式及焦点归还，目视桌面/390px；核对问题与审批重叠、旧轮身份及剩余预算，第一批退出修改保持有效。
- [键盘相关组 14/14](batch3-keyboard-final.log)：四个尺寸/模式组合原实现全部失败；修复后覆盖正反向 iframe、切文件后的原生表单、隐藏/禁用控件、嵌套菜单与背景按键。iframe 仍为 `sandbox="allow-scripts"`，父页不能读取其 DOM。内部 Escape 不跨域转发，反向循环先聚焦 frame，再由原生 Shift+Tab 进入末控件。
- [问答相关组 67/67](batch3-wait-green.log)：新增 7 项时钟回归，原实现 5 项失败；模拟一天等待不耗执行预算，已用 400ms 的 1 秒预算答复后仅余 600ms。回答/跳过/取消、两种审批与问题结束顺序、停止/迟到请求、会话隔离均覆盖。[最终测试兼容修正后 7/7](batch3-wait-final.log)。
- [最终构建](batch3-build-final.log)、[最终类型检查](batch3-typecheck-final.log)、[完整测试](batch3-test-final.log)通过：797 项，796 通过、1 项 DSH 环境跳过，0 失败。[本机检查](batch3-local.log)、[云入口检查](batch3-cloud.log)、`git diff --check` 通过。
- [最终内置场景](batch3-visual/fixture-results.json)：桌面/390px 各 20 场景，40/40 通过；复验命令 `node output/review-fixes-2026-11-01/check-fixtures.mjs batch3-visual` 复用既有隔离检查。[桌面键盘](batch3-visual/output-keyboard-1280-expanded.png)、[窄屏全屏键盘](batch3-visual/output-keyboard-390-fullscreen.png)。
- 组合验证收口：[首次构建](batch3-build.log)暴露测试 `findLast` 和选项字段不兼容，已只改测试；[首次完整集](batch3-test.log)的冷 Vite 导航超过 5 秒，改为 DOMContentLoaded 和常规 30 秒导航期限，控件仍为 5 秒。后续[焦点失败](batch3-test-focus-failure.log)经受控[时间线](batch3-focus-trace.json)定位：菜单 DOM 已卸载，Radix 仍会异步归还 trigger。测试等待 trigger 实际获焦后再关闭 Output，临时插桩已删除，没有用 sleep 或额外产品逻辑掩盖问题。

前三批保持原模型、权限、事件映射与界面 owner。后续用户授权继续修复第 7–13 项，以下记录第四批起的结果。没有真实模型、云部署或跨浏览器兼容验证。


## 第四批

- 产品变更：原权限设置行显示重置进度、失败和显式重试，同步锁阻止重复请求；只按确认结果更新，本轮响应丢失时文案明确“无法确认”。记忆设置编辑携带完整原始 `expectedSnapshot`（text/scope/evidence），主机规范化旧数据后做 409 冲突保护，不依赖时间戳；旧 expectedText 与 Agent replaceId 调用兼容。群聊失败不再传错误正文，runtimeLogger 按事件和字段类型限制可写元数据。
- 主代理 review：拒绝用内容相同来猜测授权是否陈旧，避免隐藏真实重新授权；检查日志所有调用族、字段类型和实际枚举；补文本/URL/日期/范围/证据增删各自冲突、相同时间戳、旧数据和真实 HTTP 路由覆盖。
- [记忆相关组 56/56](batch4-memory-green.log)、[HTTP 所在服务组 27/27](batch4-memory-http.log)、[分类草稿及设置并发 22/22](batch4-memory-drafts.log)、[日志相关组 10/10](batch4-logging-green.log)、[权限浏览器组 8/8](batch4-permissions-green.log)通过。权限覆盖桌面/390px 与三语，HTTP 500、网络失败、重复点击、重试、重新授权及卸载；日志用 fake bridge 的真实群 watcher 抛私密文本验证不落盘。
- [构建](batch4-build.log)、[最终类型检查](batch4-typecheck-final.log)、[隔离本机](batch4-local.log)、[云入口](batch4-cloud.log)通过。全部 [40 组内置场景](batch4-visual/fixture-results.json)通过，主代理目视[390px 失败反馈](batch4-visual/permission-failed-390.png)。
- [首次完整集](batch4-test.log)发现旧草稿断言漏掉新快照字段；冷 Vite 导航误用 5 秒控件期限，15 个设置并发子测试耗尽原 30 秒组预算。补齐断言，导航使用 DOMContentLoaded/30 秒、整组 60 秒，控件仍 5 秒；没有添加 sleep 或改产品逻辑来绕过失败。

- [最终完整测试](batch4-test-final.log)：809 项，808 通过、1 项 DSH 环境跳过，0 失败；`git diff --check` 通过。完成后才派发第五批。


## 第五批

- 产品变更：useConversationRuns 统一管理提交/重连的订阅身份、准备状态和运行/等待/接收标记，内部复用原 runStop。调用者通过所属订阅更新状态和收尾；交接整体保留状态，正常结束统一清理。Shell 保留业务准备、附件、草稿与重连编排，没有引入服务或通用框架。
- 主代理 review：修正初版将 signal.aborted 混为所有权失效导致取消终态不能提交的问题；移除按会话直接清接收状态的逃逸接口和测试专用导出。新增实际 hook/stream 浏览器回归覆盖同步重复、旧回调、并行会话、准备中停止、取消终态、交接与结束；既有恢复回归保留 off-screen 等待、StrictMode、卸载不停止主机任务。
- 样式：Composer 删除被覆盖的卡片外观/渐变，步骤和错误的布局/状态色回到 app.css 所属位置，native SVG 粗细保留；普通组件 gap8 和预览 gap2 各自保留。review 拒绝把状态色追加文件末尾，以及仅用当前 CSS 加补丁模拟旧版的比较。
- [构建](batch5-build.log)、[完整测试](batch5-test.log)通过：810 项，809 通过、1 项 DSH 环境跳过，0 失败。`git diff --check` 通过。
- [完整 CSS 比较](batch5-styles/README.md)使用 Git 原始两份 CSS 与工作区完整文件：16 上下文、3,696 个计算值无差异，16 对 PNG 字节一致；主代理独立核对 [comparison.json](batch5-styles/comparison.json)。该静态探针不代表全部交互，另行验证 [40 组内置场景](batch5-visual/fixture-results.json)全通过，并目视窄屏终态。
- 范围：解决本次审查中共享生命周期和重复样式的具体风险；AgentApp、HTTP controller、群聊仍承载各自业务编排，没有将所有大文件机械拆分。无主机/API 变更，未重复本机/云入口检查。第五批完成后才派发最后一批。


## 第六批

- 产品变更：语言/主题与 Channels 共用的 Segmented 保留原按钮和样式，仅当前单选项进入 Tab 顺序。统一的 runtime 键盘处理覆盖四方向循环与 Home/End，Space/Enter 保留按钮原生激活；禁用项不参与。没有延迟聚焦或新 UI 组件。
- 权限页：工作区移到模式选择后；禁止访问、保护路径和只读路径说明仍直接展示，具体路径通过原生 details 按需展开。路径数量三语显示，空清单不显示折叠器，重置等待/失败/重试行为保留。
- 主代理 review：合并初版重复键盘处理，去掉 RAF/timeout 聚焦尝试；核对实际 APP_LOCALES 顺序为 en/zh/ja，修正测试错误预期。强化非空洞的折叠可见性与实际剪贴板复制断言。
- 浏览器定向：权限组 14 项和外观组 3 项通过。权限以每类 65 条、共 195 条长路径检查桌面/390px、三语、原生 Enter/Space 展开折叠、全部条目保留、实际复制和无横向溢出。[布局记录](batch6-visual/permission-layout-metrics.json)中窄屏工作区标题距内容顶部 420–458px；[折叠截图](batch6-visual/permission-layout-390-collapsed.png)、[展开截图](batch6-visual/permission-layout-390-expanded.png)。该组件探针含测试控制按钮，不等同于整个设置弹窗的几何测量。
- [构建](batch6-build.log)通过。[首次完整集](batch6-test.log)受到系统 [549 秒空闲睡眠](batch6-sleep-diagnostic.json)影响，多个浏览器期限一起耗尽；只停止了[本次验证进程树](batch6-interrupted-processes.json)，未动其他运行任务。首次结果保留为中断证据，不计为通过。
- 睡眠后的[并行浏览器复验](batch6-browser-recheck.log)另有一次上下文意外关闭；[独立诊断复验](batch6-worker-diagnostic.log)19/19 通过。这一间歇问题未定位为本批引入，也没有宣称修复。后续完整集使用只持续到命令结束的 `caffeinate -i`，未改系统长期电源设置。

- [最终完整测试](batch6-test-final.log)：819 项，818 通过、1 项 DSH 环境跳过，0 失败；[最终本机](batch6-local.log)、[云入口](batch6-cloud.log)与 [40 组内置场景](batch6-visual/fixture-results.json)均通过，`git diff --check` 通过。临时防睡眠随命令结束自动释放。
- 第 7–13 项按最小范围处理完成；大文件中的其他业务编排、整体样式重写、真实模型效果、跨浏览器/手机及云部署不在本轮验证范围。未提交、推送或部署。
