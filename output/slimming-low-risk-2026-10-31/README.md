# 第二轮：剩余低风险纯逻辑（2026-10-31）

基线 `2432baa`，接续[大模块审计](../slimming-pure-modules-2026-10-31/README.md)。快速子代理逐项实现，主代理 review、验证后分别提交；根目录既有未跟踪文件 `c` 保留。会话、流式 translator、路由生命周期和组件分组/交互不迁移。

## 1. HTTP 输入解析

- 五个纯 helper 迁入 `src/pi/piHttpInput.ts`（60 行），`piHttpHost.ts` 746 → 689 行。路由和 JSON/响应/heartbeat 留原处，字段筛选、数值范围、delta clamp、默认权限和审批值均不变。
- 修正“只允许已知字段”和“其他输入一律拒绝”的模糊说明：嵌套渠道字段保留合法字符串值，名称不在此白名单过滤；浏览器解析只投影支持字段，非法必填值返回 undefined。
- 主代理运行[声明对照脚本](review-moved.mjs)，五函数与基线语法一致，其余完整 HTTP host 语法一致：[结果](http-review.json)。
- 新增 4 项边界测试；实现代理的输入/主机/渠道/桥接窄回归 62/62、静态检查通过。主代理[构建](http-build.log)、[完整测试](http-tests.log) 667/667（无跳过）、[本机](http-local.log)和[云入口](http-cloud.log)检查通过。未改变 UI，未单独重复视觉回归。

本轮只做隔离本机验证，未调用真实模型、推送或部署。
