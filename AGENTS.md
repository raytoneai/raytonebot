# AGENTS.md

RaytoneBot: a single-user AI work assistant that runs in an AgentSphere cloud sandbox. Vite +
React + TypeScript UI (forked from an AgentCanvas export, no longer synced upstream) with the
AgentUX SDK vendored under `vendor/`, and a Node runtime in `src/pi/` that drives Pi, Claude
Code and Codex.

**Read [docs/product/README.md](docs/product/README.md) first.** Roadmap and progress:
`docs/product/03-roadmap.md`. AI working rules and definition of done:
`docs/product/05-ai-workflow.md`. Troubleshooting: `docs/product/09-lessons.md`.

## Run it

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5188/. Do NOT open `index.html` over `file://` — ES modules are blocked
there and the page renders blank.

## The rule that matters

**Agent states never need a new component. Product features extend the component that already
owns their surface. Nothing gets a parallel component.**

Every state a real agent produces already has a component: streaming text, reasoning, the full
tool-call lifecycle including approval, artifacts, errors, retries, interrupts, output panel.
If something does not appear on screen, the event you emitted is wrong. It is never a missing
component. Fix the translation, not the view.

Product features that have no entry point yet extend their owner, and only these (ADR-025):

| Feature | Owner |
| --- | --- |
| Follow-up queue (visible, ordered, paused by stop, never silently resent) | `ComposerFrame` |
| History management: search, rename, delete, archive, branches | `SessionSidebar`, `MessageActions` |
| Interactive artifacts, file/PDF/HTML previews, workspace files (T2.4) | Output panel (`OutputFrame`, `outputframe/`) |
| Browser / computer takeover | Output panel source; connect only while visible |
| Questions to the user and approvals | `chatframe/approval.tsx` |
| IM channel settings and status (ADR-026) | `SettingsDialog` (its "channels" section) |
| Routines: list, on/off, run now, open conversation (ADR-033); created from chat by Raer's `create_routine` | `SettingsDialog` (its "routines" section); host logic in `src/pi/routines.ts` |
| Group chat: "+"/To member picker, group faces and previews, author per message, PM confirmation, `@` member completion (ADR-032) | `SessionSidebar`, `ShellExtras` (header/welcome), `ChatFrame`, `ComposerFrame` (`@` list; logic in `src/runtime/mentionCompletion.ts`), `chatframe/approval.tsx`; host logic in `src/pi/groupChat.ts` |

How to extend:

- Add optional props with defaults; devtools fixtures must keep rendering unchanged. Helpers go
  inside the owner's folder (`chatframe/`, `outputframe/`) and are rendered only by that owner.
- State comes from the host or the event stream; components stay presentational, logic goes in
  `src/runtime/`. Every new state must be reachable from a `?devtools=1` fixture or a test.
- Never a second panel, modal, browser view or file browser. A feature not in the table needs
  a one-page spec in `docs/product/03-roadmap.md` (entry point, state owner, acceptance) first.

## Where your work goes

| Area | Path |
| --- | --- |
| Server: HTTP controller, engines, approval, permissions, storage | `src/pi/**` |
| IM channels: connectors, chat → run bridge | `src/pi/imChannels/**` |
| Event mapping (Pi and CLI engines share it) | `src/harness/adapters/piAdapter.ts`; CLI output → Pi events in `src/pi/cliStreams.ts` |
| Front-end state, conversation restore | `src/agent-shell.tsx` |
| Brand, layout, panels, default model | `src/exported-project.ts` |
| Deploy and sandbox lifecycle | `scripts/agentsphere/`, `scripts/cloud-preview.mjs` |

```
Pi / CLI events -> piAdapter -> AgentUX StandardEvent -> view model -> existing components
```

Real turns go through `runPiTurn()` in `src/pi/piClient.ts`, not `liveEventSource()`. Keep
`runtime.transport` in `src/exported-project.ts` on `"replay"`: it gates the devtools fixture
stream, and `"sse"` without a live source renders an empty conversation.
Architecture, routes and data locations: `docs/product/02-architecture.md`. Engines and the
permission model: `docs/product/10-agents-and-permissions.md`.

## Do not touch

- `vendor/` — frozen third-party build output (MIT). If it must change, follow
  `docs/product/04-dependency-exit.md`.
- `src/slots/slotRegistry.tsx` — an exhaustive registry over every slot component. Removing
  an entry breaks the build; `src/components/agent-preview/ExportFrame.tsx` is an
  intentional stub that exists only to satisfy it.
- `src/components/**` — fix defects, or extend an owner listed above. No parallel components,
  no restructuring of the slot layout.
- Fixtures under `src/` are preview and test data, never product data. `src/event-source.ts`
  loads them with a dynamic import so the live path never requests that chunk. Do not import
  a fixture from a component to make something appear.

## Secrets

Model keys live only in the sandbox `~/.raytonebot/env` or browser session memory; the E2B key
only in this machine's shell environment. Never write either into source, the bundle, docs or
the sandbox (E2B key). Agent child processes get secrets stripped (`src/pi/runtime/childEnv.ts`).

## How to verify a change

Run the narrowest relevant checks from `docs/product/08-acceptance.md`: `npm run build`,
`npm test`, `npm run check:local` (server running), `node scripts/cloud-preview.mjs --check`.

For event-mapping or component changes, add `?devtools=1` to reveal the fixture picker and step
through every built-in scenario — reasoning, tool call and result, approval, error, retry,
exhausted and terminal incidents, interrupts, artifacts. If a state renders in a fixture but
not in a real run, the difference is in the adapter, and `src/runtime/admissionReport.ts` will
usually already say why.
