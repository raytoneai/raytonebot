# Third Party Notices

External UI and runtime libraries are consumed as package dependencies declared
in `package.json`, not by copying their source into this repository.

## Vendored prebuilt packages

`vendor/agent-ux/` contains prebuilt distributions of the AgentUX SDK packages
`@agent-ux/protocol`, `@agent-ux/runtime`, `@agent-ux/render-core` and
`@agent-ux/react`. They are resolved by the `file:` specifiers in
`package.json` and are required to build this app.

Only build output (`dist/`) is vendored; the SDK source is not part of this
repository. The upstream package metadata declares the MIT license and the
repository `https://github.com/flamingtonForAI/agent-ux-sdk`.

A second copy lives at `src/export/templates/vendor/agent-ux/` — that one is
stamped into projects produced by the scaffold exporter, so exported projects
run without depending on this repository.

## Copied fixtures

`src/fixtures/agentux/*.events.jsonl` were copied from the AgentUX SDK's
`fixtures/events` directory and are used for replay-mode previews and tests.

## Harness adapters (2026-10-03)

- `src/pi/runtime/process.ts` is copied unchanged from TelegramAgent
  (`backend/src/runtime-sdk/process.ts`), a repository by the same owner. The
  Claude Code / Codex launch flags and the Claude stdio permission protocol in
  `src/pi/cliHarness.ts` follow TelegramAgent's runtime adapters, and the Codex
  command-environment allowlist is taken from them.
- The Claude Code environment hardening variables in `src/pi/cliHarness.ts`
  follow OpenAgentCore (https://github.com/MiniMax-AI/OpenAgentCore, MIT,
  Copyright (c) 2026 MiniMax-AI), `packages/claude-sdk-adapter/src/workspace.ts`.
- nightly-labs/openbot (PolyForm Noncommercial) informed the permission model
  design only; none of its code is included.
- `src/avatars/` is ported from the Raytone avatar study in
  `output/raytone-avatars/animated`, whose interaction approach references
  CX ArtLab / Agent Robot Avatar; no upstream source or artwork is included.

## Chat markdown (2026-10-03)

`react-markdown` and `remark-gfm` (both MIT) are npm dependencies. The component in
`src/components/agent-preview/MarkdownText.tsx` follows TelegramAgent's
`frontend/src/markdownText.tsx` (same owner).
