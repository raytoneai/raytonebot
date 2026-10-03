# Open issues

Last updated 2026-10-03. Each issue records what was verified, what is unknown, and the options.
Platform facts come from probes against `api.agentsphere.run` with throwaway sandboxes.

## 1. No long-lived sandbox on AgentSphere: lifetime is at most 50 hours per window

**Status:** open, platform limitation. Needs a decision or a platform change.

Verified:

- One run window is at most **50 hours**. Asking for more is rejected at creation
  (`Timeout cannot be greater than 50 hours`) and silently capped when renewing.
- There is no "never expire" value. Omitting `timeout` gives 15 s; `timeout: 0` expires at once;
  a negative value is rejected.
- Renewing (`POST /sandboxes/{id}/timeout` or SDK `set_timeout`) resets the end to *now* + up to
  50 h. It can be repeated.
- A sandbox created with `{"autoPause": true, "autoResume": {"enabled": true}}` **pauses** at
  its timeout instead of being destroyed. Resume (`POST /sandboxes/{id}/resume`) takes ~1.2 s and
  restores everything (same PIDs, tmpfs, files, ports, URL). This lifecycle can only be set at
  creation; existing sandboxes cannot be changed.
- The platform proxy does **not** wake a paused sandbox when its URL is opened: it answers 502.

Unknown (not testable without waiting days, or not documented):

- Whether the total lifetime is capped (renewing past 50 h since creation was not tested).
- How long a paused sandbox is retained before deletion.
- Recovery: the platform runs on a single host with `SANDBOX_RECOVERY_ENABLED=false`.

Current setup: sandbox `id705on7k0a1ya1d90icj` uses auto-pause. Wake it with
`scripts/agentsphere/sandbox.py wake`; back up with `sandbox.py backup`.

Options, cheapest first:

1. **Accept pause + wake on demand** (current). Costs nothing while idle. Needs a manual `wake`
   (1 s) when the URL returns 502. Agent tasks cannot run while paused.
2. **Keep-alive renewal from outside the sandbox.** Run `sandbox.py renew` every ~24 h from a
   scheduler that holds the E2B key, for example a launchd job on this Mac (stops when the Mac is
   off) or a small always-on host or CI cron. The E2B key must not go into the sandbox
   (ADR-006). Needs a decision on where the key may live.
3. **Wake-on-access front door.** A tiny always-on proxy outside the sandbox that calls `resume`
   before forwarding, so opening the URL wakes the bot. Needs a host for the proxy and the key.
4. **Ask the platform team** for one of: a longer or unlimited timeout, auto-resume in the proxy,
   a documented paused-retention period, or persistent volumes. This would remove the workarounds.
5. **Move to a VM or VPS** for always-on operation. This contradicts the cost goal.

## 2. Providers without a Responses API cannot drive Codex directly

**Status:** partly solved.

Codex 0.153+ speaks only the OpenAI Responses API (`wire_api = "chat"` was removed). It now runs
on DeepSeek with an API key and **no Codex login**: DeepSeek serves `/v1/responses` natively,
verified on this Mac and in the cloud sandbox. RaytoneBot passes the provider through `-c
model_providers…` flags and puts the key only in Codex's own environment. OpenAI's API works the
same way.

Open: providers that serve only Chat Completions (check before enabling: Kimi/Moonshot, Z.ai,
OpenRouter, local runtimes) still cannot run Codex. Option: run a Responses↔Chat translating
gateway next to the bot, as magpie does. This was verified on this Mac: a headless
`magpie serve` (MIT, built from source with `-tags nogui`) relays both endpoints. The cost is a
37 MB Go binary and one more process in the sandbox. Do it only when such a provider is needed.

## 3. Agents and the bot share one OS user

**Status:** open (roadmap S1). Agents can, with approval, reach files the bot holds, and Codex's
commands are not gated per step. Fix: run agent processes as an unprivileged user and keep the
app and `~/.raytonebot` root-owned or read-only. See `docs/product/10-agents-and-permissions.md`.
