# Claude Code review 后续核对 · 2026-10-18

本轮仅修 sandbox 应用与本机回归；未提交、未推送、未部署，未改外部 Web/control/console、定时唤醒或平台持久权限。

| Review 条目 | 核对与处理 |
| --- | --- |
| 1 iframe 导航使快照过期 | 已复现并修复：只在当前主 frame 导航时使整页引用失效；保留动作前实际目标校验。 |
| 2 后台下载归属 | 已复现后台新增 iframe 下载丢弃；每页独立观察 frame 生命周期，切标签不会断掉观察。 |
| 3 保存回调累积 | token 不再复用；无页面/未完成 GUID 引用时 worker 通知 host 释放。仍保留迟到下载所需回调，不按工具返回即删除。覆盖换归属、清归属、拒绝动作。 |
| 4 scope 正则误拦 | 改为真实元素标签与穿帧语法检查；`.video-frame`、`#iframe-wrapper` 可用，真正 iframe scope 仍明确拒绝。 |
| 5 跨机帧年龄 | 删除该诊断值；输入到解码/绘制显示的统计沿用客户端自身单调时钟。 |
| 6 新成员介绍带附件 | 该描述不成立：新成员补充介绍已有 `record=false`；592 行属于首次问候主轮，所有成员先预校验。补测两条路径并澄清注释，没有改群聊行为。 |
| 7 fixture 特例 | 槽开关移入 fixture 元数据，经动态事件源传递；shell 不再匹配 fixture id。 |
| 8 群成员更新的旧闭包 | 状态更新从函数式回调内读取最新对话再合并成员/标题，保留期间更新的 transcript 和原排序行为。草稿保存留在 updater 外。 |

## 检查

- [修复前复现](reproduction.txt)：真实 Chromium 中后台 iframe 下载未保存，iframe 重载后主页面输入被拒绝。失败总数包含父测试汇总，不代表三个独立缺陷。
- [最终测试](tests.txt)：381/381，通过且 0 跳过；包含真实 Chromium，新增后台 iframe 慢下载在另一个任务接管同页后的原 GUID 归属，以及换归属/清归属/失败动作释放回调。
- [最终构建](build.txt)：tsc + Vite 通过；既有大 chunk 警告保留。
- [独立本机 API](local-check.txt)：新启动隔离数据/工作区主机，12 工具、空请求、跨源拒绝通过，无模型调用。
- CUA in-app browser 实看 Capability 与 Group 两个相关 fixture：能力托盘可见，切换 Group 后托盘消失，三位发言者渲染正常。未操作已有草稿、未发模型请求。
- `git diff --check -- src docs scripts` 通过。全仓检查仍报 `tmp/avatar-eye-study/` 原有空白；不修改其他会话的文件。

本次没有重跑三引擎原生协议验收（见上一批证据），没有重新采样延迟分位数，未做目标 Linux sandbox/云端验证。源码见 [source-manifest.json](source-manifest.json)，是未提交工作树快照。

提交范围：保留被产品文档引用的 `docs/review-evidence/`；不纳入 `console/`、`output/browser-login/`、`artifacts/agent-anatomy.html` 或 `tmp/avatar-eye-study/` 过程产物。本轮未暂存或清理这些文件。
