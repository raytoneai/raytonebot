# UI、UX 与注释修正验收

2026-11-01。对应 [unslop 审查中的 8 项发现](../../docs/ui-ux-unslop-review-2026-11-01.md)。基线 `c8f1f77`，分支 `codex/unslop-ui-fixes`，独立 worktree；三个子代理按错误与无障碍、设置与文案、欢迎页与注释分工，主代理逐项 review 和浏览器复验。

后续已与架构优化 `e40f7e3` 合并回主工作区 `main`，合并提交 `2cb1da3`；组合回归及桌面错误布局补修见[合并验收](../unslop-integration-2026-11-01/README.md)。下文保留独立分支初次验收结果。

## 已完成

- 普通错误优先显示用户说明，错误码与诊断保留在默认关闭的原生详情中。未知错误保留原文；重试、耗尽、终态及历史加载失败沿用既有状态标题。缺少 developerMessage 时仍保留原始 message，重复正文不再展示两遍。
- 窄屏设置在打开指定分类、分类切换、尺寸变化和语言变化时，只移动导航自身以显示当前项。手动横滑不会被持续拉回，不更改焦点、不滚动页面、不使用平滑动画。
- 学习页改为“任务复盘与经验复用”，费用、审核、作用范围、停用影响及 UTC 上限保持可见；技术说明和 token 用量按需展开。沙箱恢复提示只在 sandboxed 主机显示；Vault 导航改为三语可读名称。
- 工具展开/收起、输出关闭及输出标签列表补齐中英日无障碍名称。欢迎文案描述具体用途，并保留 Bot 改名映射。
- 注释去除失效调用关系、旧配置器背景和重复设计辩论，权限注释补齐本机与 egressContained 条件。局部标题采用现有字重 token；错误详情使用次级文字并允许长路径换行。

主代理 review 额外修正：无 developerMessage 时原始诊断丢失、语言切换造成导航越界、空结果后的悬空分隔符、隐藏详情文案误称存放在侧栏、详情入口字号抢过错误说明。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run build`（最终源代码，含类型检查） | 通过；保留既有大 chunk 提示，见 [日志](build-final.log) |
| `npm test` | 共 698 项：697 通过、0 失败、1 跳过；跳过项要求本机安装指定版本 DSH，见 [日志](test.log) |
| 最后局部修正后的错误呈现与导航回归 | 8/8 通过；[日志](targeted-final.log) |
| 隔离主机 `check:local` | 通过，无模型请求；[日志](local-check.log) |
| `cloud-preview.mjs --check` | 通过；仅本机入口策略检查，不代表云部署验收；[日志](cloud-check.log) |
| 7 个纯注释文件与基线去注释后的编译输出 | 完全相同，包括 permissionPolicy；[结果](comment-semantics.json) |
| 390 × 844，欢迎页与 19 个事件场景 | 全部渲染、无页面横向溢出；[DOM 与尺寸记录](fixtures.json) |
| 实际设置交互 | 桌面切窄屏、三语切换、手动横滑保持、键盘展开/收起、Bot 菜单直接打开记忆及关闭后重开均通过；[记录](browser-review.json) |
| 控制台与空白检查 | 检查时段内无 warn/error；`git diff --check` 通过 |

完整测试之后的局部调整只涉及语言依赖、空分隔符、隐藏详情文案和详情样式；随后重新构建、运行相关 8 项测试并完成最终浏览器走查。未重复完整测试。

## 视觉证据

- [中文窄屏设置](settings-zh-mobile.jpg)、[英文](settings-en-mobile.jpg)、[日文](settings-ja-mobile.jpg)、[暗色](settings-dark-mobile.jpg)、[桌面最终状态](settings-desktop.jpg)。
- [普通错误默认状态](error-closed-mobile.jpg)、[键盘展开诊断](error-expanded-mobile.jpg)。错误 fixture 的英文 userMessage 是测试内容，未将其改成产品翻译。

## 范围和隔离

- 本轮未改 `agent-shell.tsx`、会话等待/重连逻辑、模型、审批行为、后端接口或依赖；`permissionPolicy.ts` 只有注释变化。原仓库架构 Agent 的未提交修改未被读入或覆盖。
- 服务运行于独立端口 5196，使用 `/tmp/raytone-unslop-fixes-GkeBZh` 的临时数据和工作区。为检查指定设置入口，向该临时目录写入一条由既有 basic-text fixture 生成的合成会话；不使用用户历史、账号或凭据。
- 未调用真实模型、改变学习开关/权限、部署或推送。浏览器覆盖桌面及窄视口，未做真机触摸、完整读屏、真实写入失败或云端交互验收。
- 已保留未确认消费路径的旧字典；本轮没有把潜在残留当作已出现的界面缺陷。更大范围的架构与代码质量优化由另一任务负责。
