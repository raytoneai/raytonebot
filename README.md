# RaytoneBot

> 产品文档、路线图与 AI 开发流程：[docs/product/](docs/product/README.md)。

单用户 AI 工作助手，运行在 AgentSphere 云沙箱。UI 分叉自 AgentCanvas 导出（commit `2019158e472a360cd02897534221a8474b18ccd6`，不再同步上游），服务端在 `src/pi/`，可驱动 Pi、Claude Code、Codex 三个引擎。当前状态、已验证项与云端地址见 [docs/product/README.md](docs/product/README.md)；部署见 [06-deployment-runbook.md](docs/product/06-deployment-runbook.md)。

运行 `npm run dev` 后打开 **http://127.0.0.1:5188/**。本机未设置 `RAYTONEBOT_WORKSPACE(_ROOT)` 时，Agent 以此项目为工作目录、以当前用户权限执行，这不是隔离沙箱；默认对修改类工具请求审批。会话保存在 `~/.raytonebot/data`。检查命令：`npm run build`、`npm test`、`npm run check:local`（需先启动服务）、`node scripts/cloud-preview.mjs --check`。

下文为 AgentCanvas 导出时的原始说明，保留作组件与事件管线参考；其中“只改 `backendAdapter.ts`”等导出期限制已不适用，以 `AGENTS.md` 为准。

A self-contained Agent frontend exported from **AgentCanvas** — the same components the
AgentCanvas builder previews. Vite + React + TypeScript, with the AgentUX SDK vendored
under `vendor/`. / 从 **AgentCanvas** 导出的独立 Agent 前端(与配置器预览同一套组件),
Vite + React + TypeScript,SDK 已内置在 `vendor/`,开箱即跑。

---

## Requirements / 环境要求
- Node.js 22.19+ and npm / Node.js 22.19 及以上 + npm

## Quick start / 快速开始
```bash
npm install
npm run dev
```
Then open http://127.0.0.1:5188/.
然后打开 http://127.0.0.1:5188/。

## Production preview / 构建后预览
```bash
npm install
npm run build
npm run preview   # serves the built app over HTTP
```
Open http://127.0.0.1:5188/ (stop the dev server first).
打开 http://127.0.0.1:5188/（先停止 dev 服务）。

> ⚠️ Must be served over HTTP. Do NOT open `index.html` (source or `dist/`) by
> double-clicking / via `file://` — browsers block ES module scripts on `file://`, so the
> page shows up blank. Always use `npm run dev` or `npm run preview`.
> ⚠️ 必须通过 HTTP 打开。**不要双击 / 用 `file://` 打开 `index.html`(源码或 dist 里的都不行)**
> —— 浏览器禁止在 `file://` 下加载 ES module,页面会空白。请始终用 `npm run dev` 或 `npm run preview`。

## Open with Codex / Claude / an AI IDE / 用 AI 编程工具打开
`AGENTS.md` in this folder briefs a coding agent: where the backend seam is, which adapters
already ship, and what not to rewrite. Point your tool at it before asking for changes —
an unbriefed agent tends to build a second set of components instead of filling in the
adapter, which throws away the interface you just composed.
`AGENTS.md` 是给 AI 编程工具看的说明:后端接入点在哪、哪些 adapter 已自带、哪些不许重写。
让工具先读它再动手——没有交代的 AI 通常会另做一套组件,而不是去填 adapter,
那等于把你刚配好的界面扔掉。

To just get it running, paste this:
> This is a Vite + React + TypeScript project with the SDK vendored under `vendor/`. Read
> AGENTS.md first. Run `npm install` then `npm run dev` and give me the local URL — do NOT
> open index.html via file:// (ES modules are blocked there and the page goes blank). I
> should see the composed Agent UI. Submit a prompt to run the bundled headless Pi agent;
> use ?devtools=1 when you want the fixture-state picker.

## What you should see / 预期效果
- The full composed Agent interface; the composer runs Pi and fixtures remain available for QA.
- 完整的 Agent 界面；输入框会运行 Pi，fixture 仍可用于逐项检查 UI 状态。

## Event-source modes / 事件来源模式
`src/exported-project.ts` → `runtime.transport` decides where events come from. Everything
downstream is identical, so components cannot tell the two apart.
`src/exported-project.ts` 里的 `runtime.transport` 决定事件来源,下游完全一致,组件无法区分。

| transport | Events from | Fixture picker |
| --- | --- | --- |
| `replay` / `mock` | bundled fixtures (preview & development data) | hidden by default; add `?devtools=1` |
| `sse` | your backend, via the adapter | **hidden** |

Pi turns use the bundled local runtime and temporarily replace the fixture/backend event list
with the current Pi session events; they still enter the same AgentUX rendering pipeline.

Fixtures are preview / development / test data only — never product data. No UI component
imports them; `src/event-source.ts` loads them with a dynamic import, so the build splits them
into their own chunk and the live path never requests it. / Fixture 仅用于预览、开发与测试,
不是产品数据。任何 UI 组件都不引用它们;`src/event-source.ts` 用动态 import 加载,构建会拆成
独立 chunk,live 路径永不请求(chunk 文件仍在 dist 里,只是不加载)。

## Inspecting every UI state / 逐个查看 UI 状态
In `replay` / `mock`, add `?devtools=1` to reveal a fixture picker for the built-in demo, the 7 AgentUX
fixtures, and the 9 AgentMatrix scenarios — enough to check reasoning, tool call + result,
approval, error, retry, exhausted/terminal incidents, interrupts, artifacts, and capability
states against what you saw in AgentCanvas. / `replay`/`mock` 下,加 `?devtools=1` 可显示事件流选择器,切换内置 demo +
7 个 AgentUX fixture + 9 个 AgentMatrix 场景,用来逐一核对思考、工具调用与结果、审批、错误、
重试、耗尽/终止、打断、产物、能力等状态。

## Connecting a real backend / 接入真实后端
Edit `src/adapters/backendAdapter.ts` — that is the only file you need to touch:

```
backend raw payload
  -> BackendEventAdapter.toStandardEvents()   <- you implement this
  -> StandardEvent (AgentUX protocol)
  -> view model
  -> slotRegistry -> the existing UI components
```

1. Implement `toStandardEvents(raw)` for your backend. Return `[]` for keep-alives — but
   check the two shortcuts below first, because for Claude Code, Codex and opencode the
   translation already ships in this package.
2. Return a source from `liveEventSource()` (`createSseEventSource` is provided).
3. Set `runtime.transport` to `"sse"` in `src/exported-project.ts`.

Text, reasoning, the whole tool-call lifecycle including approval, artifacts, errors, retries
and interrupts are already handled: emit the matching standard event and the existing
component renders it. **Do not build new UI for a new backend.** If your backend already
speaks the AgentMatrix protocol, `createBackendStreamSource` (`./agentmatrix`) plus
`toAgentUXEvents` are bundled too.
1. 为你的后端实现 `toStandardEvents(raw)`——但先看下面两条捷径,Claude Code / Codex / opencode
   的转译本包已自带;
2. 在 `liveEventSource()` 里返回事件源(已提供 `createSseEventSource`);
3. 把 `runtime.transport` 改成 `"sse"`。
文本、思考、完整工具调用生命周期(含审批)、产物、错误、重试、打断都已支持——发出对应的标准事件,
现有组件就会渲染。**不要为新后端另做一套 UI。**

### Shortcut A — an agentic CLI's JSONL / 捷径 A:直接吃 CLI 的 JSONL
Claude Code, Codex and opencode already run the loop (tools, approvals, file writes). Their
process is not in the browser, so you consume the JSON lines they printed — and the mapping
table for all three is already here. You write no translation.
Claude Code / Codex / opencode 自己就会跑工具、审批、写文件。它们的进程不在浏览器里,所以你消费
它们打印的 JSON 行——三家的映射表本包已自带,转译不用你写。

```ts
import { importHarnessJsonl } from "../harness/adapters/jsonlImport";

const result = importHarnessJsonl(text, "claude");   // or "codex" | "opencode"
if (result.ok) onEvents(result.events);
else console.error(result.error);
```

For a live stream instead of a finished file: `parseHarnessLines` +
`translateHarnessStream(lines, mappingForHarness("claude"))`. Check `producedNothing(result)`
— a table that matched nothing renders an empty transcript that looks like a working
connection. / 流式场景用 `parseHarnessLines` + `translateHarnessStream`,并检查
`producedNothing(result)`:表没匹配上时会渲染出一个「看起来连上了」的空对话。

### Shortcut B — a model API directly / 捷径 B:直连模型 API
One HTTP request to a model. **No tools are executed** — this is the chat-shaped route, not
an agent that does work. / 一次 HTTP 请求,**不执行任何工具**——这是对话形态,不是会干活的 Agent。

```ts
import { createAnthropicHarness } from "../harness/adapters/anthropicAdapter";

const harness = createAnthropicHarness({ baseUrl: "/api/anthropic", model: "claude-sonnet-5" });
for await (const event of harness.connect({ prompt })) onEvents([event]);
```

> ⚠️ Do NOT put an API key in the browser. `baseUrl` is configurable so it can point at a
> server you control that holds the key. A key shipped to the browser is a published key,
> and Anthropic blocks direct browser calls with CORS unless an opt-in header is sent —
> this package does not send it, so a browser aimed at `api.anthropic.com` fails either way.
> ⚠️ 不要把 API key 放进浏览器。`baseUrl` 可配就是为了指向你自己持有密钥的服务端。前端带 key
> 等于公开密钥;而且 Anthropic 会用 CORS 拦截浏览器直连(需要一个额外的 opt-in 头,本包不发),
> 所以直接指向 `api.anthropic.com` 无论如何都不通。

## Built-in Pi runtime / 内置 Pi 运行时
The composer runs the open-source Pi agent through a same-origin local Node host. Submit, stop,
new session, provider/model selection, model discovery and tool approvals work immediately.
输入框通过同源本地 Node 服务运行开源 Pi Agent；发送、停止、新会话、模型切换、模型拉取和工具审批
均已接通。Pi works in the exported folder, so its file and command tools use this folder as cwd.
Pi 在导出目录中运行，因此读写文件和命令工具的工作目录就是当前导出目录。

A session key is held in memory and sent only to the local Pi host. It is never written into
the project, export zip or browser bundle. Pi can also use its normal local credentials.
会话 Key 只保存在内存并发送给本机 Pi 服务，不会写入项目、ZIP 或浏览器 bundle；也可直接使用
Pi 已有的本机凭据配置。Git commit/push remains a product-specific integration.

## Customize / 自定义
- `src/exported-project.ts` is the snapshot of what you composed — edit it to tweak layout,
  theme, style preset, and enabled panels. / `src/exported-project.ts` 是你的配置快照,
  可手改布局/主题/样式预设/面板。
- UI components live under `src/components/agent-preview/`.
- `src/agent-shell.tsx` renders through `src/slots/slotRegistry.tsx` — the same registry
  AgentCanvas uses, which is why this package looks identical to the preview.
  / `src/agent-shell.tsx` 经由 `src/slots/slotRegistry.tsx` 渲染(与配置器同一份注册表),
  这是导出包与预览一致的原因。

---

_Generated by AgentCanvas._
