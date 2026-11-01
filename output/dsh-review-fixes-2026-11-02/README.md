# dsh-superagent 审计建议分批验收

日期：2026-11-02。起点 `72fb732`，分支 `codex/vps-isolation-dsh`。用户授权子代理实施、主代理 review，每批验证后独立提交。

## 范围

1. 停止/中断的历史说明与讨论模式主机只读约束。
2. 轮次来源/权限快照与审批/拒绝的结构化关联记录。
3. 例行任务等待说明与结构化业务结果，保留原入口、模型与权限。

不实现 observe、状态聚合徽标或新通知系统；控制面认证另行核验。测试使用临时数据、受控引擎，不修改真实用户任务或凭据，不推送或部署。

## 第一批

- 子代理分别实现停止历史和讨论限制，主代理 review 补查真实 Pi SDK 的 `connect_channel` / `create_routine` 绕过闸门路径；两者现经同一 guard。另修正只读 `group_tasks` 的取消分支，并移除终态说明里技术性的 session 标签。
- 停止说明由既有步骤行显示，刷新后保留；只有主机启动恢复写入明确的 `host_restart` 原因，旧取消不猜测原因。原始事件、队列、复制/分支、vendor 与模型不变。
- 讨论成员和汇总允许安全读取，拒绝副作用；真实已安装 Pi SDK 与受控模型协议验证写文件、命令、频道/例行创建均被挡住，普通执行仍到达回调。顺序 PM 授权保留。此处不承诺新增物理隔离或改变原生 Codex 安全读取。
- `npm run build` 通过；保留已有大 chunk 提示。[日志](batch1-build.log)
- `caffeinate -i npm test`：850 项，849 通过，1 项缺少指定 DSH 环境跳过，0 失败。[日志](batch1-tests.log)
- 隔离临时数据的本机接口检查与云入口策略检查通过，无模型请求。[本机](batch1-local.log)、[入口](batch1-cloud.log)
- 停止/重启中断在 en/zh/ja、1280px/390px 下刷新保持，成功无标识；主代理目视[窄屏中断](batch1-visual/zh-390-restarted.png)与[桌面停止](batch1-visual/en-1280-stopped.png)。初次浏览器测试发现其独立 Vite 缺少 Markdown 预构建依赖，修正测试配置后完整复跑通过；不是产品功能失败。
- 桌面/390px 各 20 个内置场景，40/40 通过，无页面错误或横向溢出。[回执](batch1-fixtures/fixture-results.json)。未调用真实模型、修改用户数据或部署。

## 第二批

- 主机入口写入可选 `StoredTurn.provenance`，旧记录保持无来源；HTTP 不接受客户端伪造来源，IM 保存已授权 sender，例行保存 routine/occurrence。群父轮保留接受请求时的权限，PM 确认后的子轮记录实际权限及原请求权限，委派关联公共群/父 run/task。
- 复用 `runtime.jsonl` 的 `tool.decision`：会话/run/native tool ID、固定工具名/分类/决定/原因枚举；不保存参数、路径、命令、自由文本或参数摘要。纯查询和自动放行不产生审批记录；日志仍为既有尽力写入、两文件轮转，不承诺防篡改或覆盖原生协议在回调之前的全部拒绝。
- 90 项定向测试通过；实际 HTTP、ChannelBridge、RoutineService、群/委派、存储重载和 controller 日志验证来源及关联。受控 Claude/Codex 可执行协议经过真实 controller 回调，确认秘密/只读拒绝各记录一次；没有调用真实模型或新验 DSH 进程。
- `npm run build` 通过，[日志](batch2-build.log)。完整测试 861 项，860 通过、1 项指定 DSH 环境缺失跳过、0 失败，[最终日志](batch2-tests.log)。[首轮失败](batch2-tests-first.log)为上一批浏览器测试的冷启动导航超过 5 秒；主代理把导航预算独立设为 30 秒，行为断言仍为 5 秒，完整复跑通过。
- 隔离本机与云入口检查通过：[本机](batch2-local.log)、[入口](batch2-cloud.log)。本批未改变产品界面或事件投影，未重复开发场景扫图；完整测试包含既有浏览器回归。未推送或部署。

## 第三批

待第二批提交后实施。
