# 04 脱离参考仓库

目标：RaytoneBot 不再跟随任何上游同步，所有代码要么是自有代码，要么是锁定版本的普通 npm 依赖。原则是**先断开“依赖关系”，再按需清理“代码残留”**——删代码本身不产生用户价值，只在它阻碍修改时做。

## 依赖清单与处置

| 来源 | 当前关系 | 处置 | 时机 |
| --- | --- | --- | --- |
| AgentCanvas（raytone-lab/agentcanvas，commit `2019158e`） | 本项目分叉自其导出物；无上游服务依赖、无同步机制。冻结 SDK 构建产物未被 Git 收录，见下文 | **不再从上游合并**。根 README 与 AGENTS 维护本项目说明，不保留“只许改 adapter”等导出期指引 | M0 |
| AgentUX SDK `vendor/agent-ux/*`（MIT，冻结构建产物） | 渲染管线核心，源码通过 `@agent-ux/*` 引用 | 保持冻结、不改。真要改时：把四个包的 `dist/index.js` + `.d.ts` 迁入 `src/agentux-sdk/`，改 `package.json` 与 import 路径，保留 MIT 声明于 `THIRD_PARTY_NOTICES.md` | 需要时 |
| `vendor/agentmatrix/agentcanvas-contract` | 仅 `schema/agentuxConfig.ts`、`ProductBrandMark.tsx` 两处引用 | 冻结。迁入方式同上；也可只内联用到的类型与常量 | 需要时 |
| `@earendil-works/pi-coding-agent` / `pi-ai` 1.0.1（工作树） | 产品核心运行时，精确锁定版本 | 升级单独开任务并完成 [08](08-acceptance.md) 全量；本机兼容与审计、新版 Linux 隔离、三引擎真实外部模型、暂停/唤醒及跨实例恢复通过，见 P 组。未逐项重验路径仍列明，不能把旧版云端证据算作新版验收 | 每次升级 |
| OpenAgentCore（MiniMax-AI） | 零代码依赖，仅调研 | 不引入。借鉴点（幂等提交、断线读历史、不确定任务不重放）在 M3 用自有代码实现 | — |
| nightly-labs/openbot | 零代码依赖；PolyForm Noncommercial，**不可复制代码** | 只借鉴行为（工作区、队列、中断标记、按需唤醒） | — |
| CopilotKit OpenXX（OpenDots/OpenBot 等） | 零代码依赖 | 只借交互灵感 | — |

2026-10-04 依赖修复：0.84.4 发布包的 `npm-shrinkwrap.json` 固定了受影响的 undici / brace-expansion，
根项目 `overrides` 在干净安装中仍未生效。[Pi 1.0.1 发布记录](https://github.com/earendil-works/pi/blob/v1.0.1/packages/coding-agent/CHANGELOG.md)
明确移除该文件并修复依赖；因此在隔离副本验证后更新两项直接依赖，保留精确版本与 lockfile。
未使用 `audit fix --force`，未修改 vendor 或默认模型，也未启用新增的 MCP / codemode 工具；模型实际可见的工具仍是原八项。

## 完整工作副本要求

2026-10-22 核对：根 `.gitignore` 的 `dist/` 也匹配 vendor 包的构建目录；Git 只收录这些包的 `package.json`，未收录其导出的 JS 与类型文件。它们没有本地构建脚本，`npm install` 只建立 `file:` 依赖，不能补回缺失文件。

新 clone 或 worktree 在安装、构建和部署前，须从可信的完整工作副本原样复制以下目录：

- `vendor/agent-ux/protocol/dist/`
- `vendor/agent-ux/render-core/dist/`
- `vendor/agent-ux/runtime/dist/`
- `vendor/agent-ux/react/dist/`
- `vendor/agentmatrix/agentcanvas-contract/dist/`

缺失时会出现包入口无法解析或找不到类型声明。此处记录现有准备要求；构建产物的仓库分发仍是待解决项，不重新生成、不修改冻结内容。AgentMatrix `--clean` 发布脚本会从当前完整工作副本复制 vendor；仍依赖当前副本已具备这些文件。

## 导出残留代码

这些模块来自 AgentCanvas 的配置器/多后端支持，Pi 路线不用或只用一部分。**删除前必须用 `npm run build`（含 tsc）确认无引用；`src/slots/slotRegistry.tsx` 是穷举注册表，删条目会让构建失败。**

| 模块 | 说明 | 建议 |
| --- | --- | --- |
| `src/agentmatrix/protocol.ts`、`icons.tsx`、`fixtures/`、`legacyAdapter.ts` 及头像组件 | AgentMatrix 协议类型、图标、场景和兼容转换 | 保留，视为自有 |
| `src/agentmatrix/client.ts`、`mockSse.ts`、`projector.ts`、`stateDemo.ts`、`useSession.ts`、`viewModel.ts` | 未被应用引用的 AgentMatrix 客户端、演示和视图模型 | 已删除；barrel 仅导出保留模块 |
| `src/harness/adapters/` 中非 Pi 的映射与通用转换模块 | 未被应用或测试引用的其他后端转译 | 已删除；保留 `piAdapter` 及其测试 |
| `src/preview-runner/PreviewRunner.ts` | Git 预览状态类型入口，`GitFrame` 与穷举 slot registry 仍引用 | 保留为 `GitPreviewState` 类型转出；其余预览脚手架已删除 |
| `src/export/scaffoldManifest.ts` | 仅为 slot registry 提供类型的导出管线 stub | 保留；真实导出管线未发布 |
| `src/fixtures/**`、`demo-events.ts` | 测试数据（动态 import，不进生产路径） | 保留给测试与 `?devtools=1` |
| `src/components/agent-preview/ExportFrame.tsx` | 为满足注册表存在的空壳 | 保留 |
| 接口前缀 `/__agentcanvas/pi`、插件名 `agentcanvas-pi-runtime` | 命名残留，仍为当前接口 | 保留兼容；改名是可选清理（T1.7），不作为功能前置 |
| `exported-project.ts` 中 `surface.mode: "agentcanvas"` 等字段 | 组件依赖的配置键 | 保留键名，只改值；文件可在后期改名 `product-config.ts` |

## 完成判定

- `AGENTS.md`、`README.md` 中不再要求“回上游修改”或“只改 adapter”。
- `package.json` 中没有指向上游 git 仓库的依赖；`file:` 依赖只指向仓库内冻结目录。
- `THIRD_PARTY_NOTICES.md` 列出 AgentUX（MIT）与 Pi 依赖的许可。
- 构建、测试、`check:local` 全过。
