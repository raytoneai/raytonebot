# 独立检查脚本认证迁移：本机验证记录

日期：2026-11-02。源码基线：`b97d55b` 加本轮修改；以下为提交前的验证快照，未推送或部署。

本文件记录本会话已执行的命令及实际观察结果，没有复制原始终端日志。此次仅新增本证据，不覆盖既有验收记录。

## 范围

- `scripts/check-user-input.mjs`：通过现有 `authenticatedFetch` 执行主机一次性入口交换，取得 cookie 与 CSRF 后提交回答；保留匿名、错误会话负例及原业务断言。脚本仅直接执行时启动原生检查，供测试导入的回答工厂不启动 CLI。
- `scripts/check-user-input.d.mts`、`src/pi/checkUserInputScript.test.ts`：为该脚本的实际 HTTP 回答工厂提供类型及轻量回归。现有 `npm test` 的 `src/pi/*.test.ts` 匹配会包含此测试，不要求安装原生 CLI。
- `scripts/check-browser-latency.mjs`：补充一次性 fragment 入口的清理与页面会话初始化，以及独立 `--check` HTTP smoke；公开 HTML 不下发入口秘密。
- 两个脚本使用临时数据和显式临时 Vault 目录；退出时等待 `host.dispose()`、服务器关闭后清理目录。未改产品后端、前端或文档。

## 已执行命令与结果

| 命令 | 实际结果 |
| --- | --- |
| `node scripts/check-user-input.mjs` | 最终复跑退出码 0，六个原生场景全部输出 PASS：Pi `ask_user` 和已安装 Claude CLI `AskUserQuestion` 各验证回答、跳过、停止。 |
| `node --test src/pi/checkUserInputScript.test.ts` | 1/1 通过，退出码 0。真实 HTTP host、真实会话交换与受控 bridge，不调用原生 CLI 或模型。 |
| `node scripts/check-browser-latency.mjs --check` | 退出码 0：匿名 `browser/state` 返回 401；通过真实会话交换的请求返回 200；公开页面返回 200 且 HTML 不含入口秘密。 |
| `node scripts/check-browser-latency.mjs --check --slow` | 退出码 0，同样通过上述认证 HTTP smoke；接收输入批次为 0。 |
| `node --check scripts/check-user-input.mjs` | 语法检查通过，退出码 0。 |
| `node --check scripts/check-browser-latency.mjs` | 语法检查通过，退出码 0。 |
| `npm run typecheck` | 最终检查通过，退出码 0。新增回归的请求头联合类型曾报错，明确标注请求头数组类型后通过。 |
| `git diff --check` | 最终检查通过，退出码 0。 |

原生六场景使用真实 Pi SDK、真实 Claude CLI 与本机受控 Anthropic 协议端点。每个等待中的问题均验证：匿名及错误 cookie 请求返回 401，pending 问题仍存在；有效会话下，错误会话归属返回 409、空答案对象返回 400、回答或跳过返回 200、相同回答重试返回 200、冲突回答返回 409。停止后迟到回答返回 409；运行及保存历史中的等待状态均被清除。

首次原生执行已全部通过；随后为脚本和轻量测试显式绑定临时 Vault，再次执行原生六场景并全部通过。以上最终原生结果对应这次复跑。没有访问真实模型服务或登录账号。

## 窄查结果与验证限制

- `scripts/check-local.mjs` 已支持私有 `--session-file`，没有修改。
- 所查其他独立检查脚本只通过 controller、原生 CLI 或本机模型 fixture 调用，不存在相同的匿名产品 HTTP 提交路径，没有改动。
- `--check --slow` **仅是带人工传输延迟的认证 HTTP smoke**，不是实际 BrowserView 输入延迟测量。没有本轮浏览器视觉验收，也没有测量或报告 p50/p95。
- 本轮没有运行完整 `npm test`、完整构建或线上验收。没有保存入口 URL、cookie、CSRF 值或一次性入口秘密。
