# 2026-10-18 M5 第二批证据

对应 T5.5 群任务负责人/结果回收、T5.6 结构化表单、T5.7 本地文本工作区。基线 `27ac5d5` 加未提交工作树，见 source-manifest.json。未部署，没有外部模型调用；现有默认模型与权限配置未改。

## 最终自动化检查

- [tests.txt](tests.txt)：395/395，0跳过，包含真实Chromium。文件/HTTP/事件/审批/恢复测试不是完整三成员模型实测。
- [build.txt](build.txt)：TypeScript + Vite通过；既有大chunk提醒保留。
- [local-check.txt](local-check.txt)：临时数据/工作区启动真实Pi SDK，入口、工具、空提示词与跨源检查通过；无模型请求。
- [native-engines.jsonl](native-engines.jsonl)：`node scripts/check-engine-parity.mjs` 使用已安装Pi SDK、Claude CLI、Codex app-server，loopback受控模型/MCP，三引擎同任务均通过。验证已有原生链路未被本轮host/gate改动破坏，不等于新增功能的真实外部模型验收。
- [umask-reproduction.txt](umask-reproduction.txt)、[umask-fixed.txt](umask-fixed.txt)：严格umask下组权限丢失先失败后通过，最终全量测试亦覆盖。

## 浏览器实测

隔离5198主机使用临时data/workspace和受控bridge，IAB实际点击，未接触5188的用户数据。后端在本轮中间工作树启动，前端由HMR更新；最终后端另由上方回归检查。不能把截图标为最终部署包或真实模型结果。

- [form-submitted.png](form-submitted.png)：必填校验后提交，字段封存、完成状态、查看结果定位原回答。来源落盘摘要见 [ui-submission.json](ui-submission.json)。较早5197隔离页面验证输入刷新恢复，后续修正测试bridge模型配置后在5198完成提交。
- [document-reference.png](document-reference.png)：保存/编辑文档后，新会话从原工作区shared搜索找到并附加，刷新后仍保留引用。受控HTTP测试另外实际读取了附件路径的最新字节；UI回执本身不冒充模型读取证明。
- [document-conflict.png](document-conflict.png)：编辑过程中测试程序修改临时文件，保存409，编辑草稿仍在，服务端新字节未覆盖。
- [fixtures.json](fixtures.json)、[fixtures-contact.jpg](fixtures-contact.jpg)、fixtures/：逐项打开19个原有场景，涵盖思考、工具/审批、错误/重试/终止/中断、产物、群作者及Capability。截图较最终umask/后端修复早，非本轮新任务界面的浏览器证明。

## 已实现契约与限制

群任务在原group metadata保留未决任务及最近十组完成任务；进程重启只标待核对，由用户显式 `/task <id> complete|cancel|retry`。重试来源失效时拒绝。群成员写轮次串行，并行讨论经host闸门只读；不建立操作系统级锁，也不改变普通单聊并发。

`.form.json`显式schema、稳定请求身份及封存值沿原Composer队列与原生请求去重；失败不自动重放。草稿在同源浏览器，不跨设备。文档限定UTF-8 md/txt ≤256KiB；有界路径/关键词检索，无向量服务。保存与来源metadata不是单一事务，元数据失败可能留下已保存文件，需要核对后重试。

未做本轮390px、真实模型、目标Linux UID、云端部署、跨设备验收或 `cloud-preview --check`。第一批浏览器上传视觉权限与最终延迟复采缺口未消除。外部control/console、Web唤醒/常驻调度、平台保留权限和过程产物均未修改。
