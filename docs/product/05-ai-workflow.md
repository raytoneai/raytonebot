# 05 AI 开发工作流

所有代码由 AI 编程工具编写，人负责：定方向、做本文“需人决定”的选择、验收。本文让任何一个新开的 AI 会话不靠口头交接也能接着干。

## 每次会话的开场

1. 读 `AGENTS.md` → [03-roadmap.md](03-roadmap.md)（找下一个未完成任务卡和进度日志）。
2. 动服务端、接口、存储前读 [02-architecture.md](02-architecture.md)；想改技术路线前读 [07-decisions.md](07-decisions.md)。
3. 排障先在 [09-lessons.md](09-lessons.md) 按主题搜。
4. 小改动（文案、样式、单函数修复）不必预读全部文档。

## 任务卡模板

派任务时复制此模板，填好再交给 AI；路线图里的每个 T 编号就是一张卡。

```markdown
### T<编号> <标题>
目标：用户可感知的结果，一句话。
范围：允许修改的文件/目录；明确不碰的部分。
接口变化：新增或改动的 HTTP 路径、事件类型、配置键（无则写“无”）。
验收：对应 08-acceptance.md 的哪些条目；新增的检查命令。
需人决定：模型选择、不可逆操作、对外发布等（无则写“无”）。
```

## 硬规则

- **不新增并行 UI 组件**。界面缺状态时，先查 `piAdapter.ts` 发出的 AgentUX 事件和 `src/runtime/admissionReport.ts`。现有组件已覆盖文本、思考、工具全生命周期、审批、产物、错误、重试、中断。
- **不引入新的后端、数据库或框架**，除非 [07](07-decisions.md) 新增了对应 ADR 且用户同意。
- **不改 `vendor/`**；`slotRegistry.tsx` 保持穷举。
- **密钥不入库、不入 bundle、不入沙箱以外的日志**：`E2B_API_KEY` 只在本机脚本进程；模型 key 只在沙箱 `~/.raytonebot/env` 或浏览器会话内存；访问密码只在 `.agentsphere/access.txt` 和沙箱 env。文档里写变量名，不写值。
- **不擅自换模型**。默认模型属于“需人决定”。
- **审批语义不能弱化**：默认 `request` 模式下修改类工具必须先问。任何改动若让审批失效，必须在完成报告里写明。
- **不自动重放不确定的任务**，宁可标记中断让人重试。
- 销毁沙箱、覆盖云端数据、推送远端仓库前先问人。

## 完成标准（Definition of Done）

1. 实现只覆盖任务卡范围；没有顺手重构。
2. 跑最窄相关检查并贴实际输出：至少 `npm run build`；有测试则 `npm test`；动了 Pi 接口加 `npm run check:local`；动了云入口加 `node scripts/cloud-preview.mjs --check`。
3. 涉及界面的改动，用浏览器实际看过（本机 `http://127.0.0.1:5188/`，状态检查用 `?devtools=1`）。看不了就写“未做视觉验收”，不得写“已验证”。
4. 更新文档：
   - [03-roadmap.md](03-roadmap.md)：勾选任务卡，进度日志加一行（日期、结果、验证方式）。
   - 改了架构/接口/目录：[02](02-architecture.md)。
   - 做了技术取舍：[07](07-decisions.md) 加一条 ADR。
   - 踩了坑：[09](09-lessons.md) 加一条。
5. 完成报告写清：做了什么、验证了什么、**没验证什么**。“HTTP 200”不等于“功能可用”，“演示事件能显示”不等于“真实模型可用”。

## 推荐分工

| 工作 | 适合 |
| --- | --- |
| 单任务卡实现、修 bug | 单个 AI 会话直接做 |
| 大改前的方案、ADR 草稿 | 先出方案让人确认再动手 |
| 独立且不共享文件的任务（如部署脚本 vs 前端会话恢复） | 可并行给两个会话，各自更新进度日志 |
| 代码审查、第二意见 | 另一个 AI（Codex ↔ Claude）交叉审 |

## 命令速查

```bash
npm install
npm run dev                         # 本机 http://127.0.0.1:5188/
npm run build                       # tsc + vite build
npm run check:local                 # 需先启动服务；不调用模型
node scripts/cloud-preview.mjs --check
# 部署相关见 06-deployment-runbook.md
```
