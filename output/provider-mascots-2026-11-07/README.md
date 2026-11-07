# Raytone 模型伙伴 · 2026-11-07

六个可选头像已接入原 BotEditor → AgentAvatar，不自动替换用户当前头像。在「编辑 Bot → 头像与外观 → 头像主题 → 模型伙伴」下选择角色；左侧「预览动作」可检查 12 个状态。切回「自定义 Bot」主题恢复原来的脸型、发型、配饰和颜色。选择形象不更换模型或引擎。[主题接入与最新编辑器截图](../avatar-theme-2026-11-07/README.md)。

| 角色 | 设计 | 动作特征 |
| --- | --- | --- |
| ChatGPT / OpenAI | 白色主体、黑色环结与胶囊眼 | 思考抬眼、环结轻亮，输出点头 |
| Claude / Anthropic | 陶土橘小蟹、柔化方头与星号 | 思考歪头，工具调用交替动爪 |
| DeepSeek | 品牌蓝鲸、浅蓝腹部与水花 | 查阅逐行扫视，工具调用摆尾 |
| Grok / xAI | 石墨色星球、斜向轨道与浅色眼睛 | 思考侧望，执行时眯眼扫视 |
| Gemini / Google | 红黄蓝绿四芒星与小星光 | 思考星光轻亮，输出轻点头 |
| Qwen / Alibaba | 亮蓝花结与白色线条 | 思考视线游移，输出点头与标记呼吸 |

全部共享待机、倾听、思考、输出、工具执行、查阅、修改、等待确认、完成、任务失败、连接中断、休息。真实运行仍由原 `avatarActivity` 映射驱动；CSS 只在对应状态动，原离屏暂停、长任务减速、减少动态效果继续有效。标题静态规则保持原样。

## 设计交付

- [互动预览](preview.html)：离线可打开，点击状态切换六个头像。为 CSS 状态演示；实际产品另有 JS 眨眼、视线、姿态过渡及完成后回待机。
- [动画预览](motion.gif)：待机 → 思考 → 输出 → 工具调用。
- [设计总览](lineup.png)、[深色背景](lineup-dark.png)、[桌面编辑器](editor-desktop.png)、[手机编辑器](editor-mobile.png)。
- 独立透明底 SVG：[ChatGPT](chatgpt.svg)、[Claude](claude.svg)、[DeepSeek](deepseek.svg)、[Grok](grok.svg)、[Gemini](gemini.svg)、[Qwen](qwen.svg)。这些导出是静态头像；产品直接使用源 SVG 生成器和现有动作系统。
- 源设计在 `src/avatars/providerArtwork.ts`；共享渲染在 `src/avatars/botAvatar.ts`。沿用原生矢量与材质，没有生成位图或增加动画依赖。

## 灵感与来源

配色按用户要求贴近当前官方 Logo，保留 Bot 的原有造型和动作。ChatGPT 按用户进一步纠正采用白色主体和黑色细节，Grok 保留黑色主体和白色细节；Claude 主色 `#D97757` 来自本地官方 Claude Code SVG；DeepSeek 主色 `#4D6BFE` 对照[官网](https://www.deepseek.com/) CSS；Qwen 的 `#082DFF` 从本地官方 PNG 的实色像素取得。Gemini 的蓝 `#3186FF`、红 `#F94645`、黄 `#F9BF15`、绿 `#10B866` 采样自官方图标，并以原生 SVG 渐变近似其色彩分布。立体高光和阴影仍会产生明暗变化。[官方图标文件与来源](../../public/brand/providers/README.md)。

采用角色化标识与 Bot 两只胶囊眼结合的方向，属于 Raytone 原创演绎。网上拟人二创有多种版本，不主张这一套是官方或唯一形象。

- [Anthropic 仓库关于 Clawd 的讨论](https://github.com/anthropics/claude-code/issues/8536)：橘色蟹形轮廓的参考。
- [DeepSeek 官方模型卡](https://fe-static.deepseek.com/chat/transparency/deepseek-v3.2-model-card-0414-CN.pdf)：蓝鲸标识的参考。
- [LLM 角色化设计案例](https://note.com/momoirogateway/n/n9c4070aff42e)：标识与眼睛/角色表情结合的参考。其图像未复制进项目。
- 其余造型以对应品牌色和标识意象作原创简化，并非复刻某位画师的拟人设定。

## 验证

- ChatGPT 白色主体修订：[构建](white-build.log)、[15 项头像检查](white-tests.log)及预览取景检查通过；同步浅深色截图、独立 SVG 与动画。本次未重复整套回归或部署。
- 配色修订：[构建](palette-build.log)及 [15 项头像定向检查](palette-tests.log)通过；检查亮暗背景、小尺寸与全部 288 个角色/状态/时间组合的视口边界，重新生成 SVG、总览和动画。此轮未重复以下初版全量/应用内流程；桌面和手机编辑器截图保留为配色修订前的流程证据。
- [构建](build.log)通过；仍有既有的大体积依赖 chunk 提示。
- [定向测试](tests.log)：35 通过，0 失败。覆盖配置保存与真实编辑器动作、减少动态效果和三语/手机入口。
- [完整回归](full-tests.log)：1016 项，1015 通过、1 跳过、0 失败/取消。角色取景留白调整后复跑构建与定向检查，未重复整套回归。
- [应用内检查](ui-checks.json)：在隔离临时主机数据上保存/刷新蓝鲸、侧栏和欢迎页同步、恢复原自定义设置；桌面与 390px 的 40 个内置开发场景均通过，无页面异常或横向溢出。[复验脚本](check-ui.mjs)。
- [本机入口检查](local-check.log)与[云入口自检](cloud-check.log)通过。本机入口使用隔离数据和临时 0600 控制会话文件；测试结束后删除。
- 检查浅色、深色背景及 20/32/48px；逐帧发现并修正蓝鲸转头时尾部贴边的问题，给角色 SVG 增加统一取景留白。[边界检查](motion-bounds.json)覆盖六种角色 × 12 个状态 × 4 个采样时刻，均未超出 SVG 视口；[渲染脚本](render-preview.mjs)可重生成动画和截图。

未改用户现有 Bot 数据，未调用真实模型、部署或推送。真实模型事件产生的运行效果未新增端到端验收；本次使用现有事件映射测试、实际组件及开发场景验证。
