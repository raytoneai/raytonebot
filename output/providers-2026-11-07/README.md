# Provider directory and picker — 2026-11-07

Extended the existing SettingsDialog / ProvidersSection with six presets: Raytone, Qwen (DashScope), xAI, Mistral AI, Groq and SiliconFlow. Together with existing OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Z.ai and Moonshot, the picker has 13 branded services plus local/custom connections.

The shipped project now reads the shared catalog, retaining its existing DeepSeek endpoint and `deepseek-flash` default. New entries start disabled. The existing restore/store path fills in missing catalog entries in older profiles while preserving edited addresses, models, enabled state and endpoint-bound credentials. No new storage schema, service, package or runtime API.

## Interface

- Compact logo/name/domain rows, grouped into model providers, gateways/inference and local/custom.
- Search names, addresses and model IDs; configured services (including disabled ones) stay in the existing list and are excluded from the add picker.
- Existing inline editor, explicit save/discard, connection probe and manual model ID remain in place. Keyboard focus moves from search to the newly added service's address.
- English, Chinese and Japanese copy; existing light/dark themes and mobile layout. Brand images are decorative alongside accessible text labels, and load only from the app.
- [Official asset sources](../../public/brand/providers/README.md).

UX references: [Cherry Studio's search → credentials → models flow](https://cherryai.com/docs/en/mobile/providers-and-models/) and [Open WebUI's compact connection management and model discovery](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/). The implementation keeps this project's dialog and explicit-save semantics.

## Endpoint references

| Preset | Base URL | Reference |
| --- | --- | --- |
| Raytone | `https://iruidong.com/v1` | User-supplied endpoint; [official site](https://iruidong.com/). Unauthenticated `/v1/models` returned 401; no credentials sent. |
| OpenRouter (existing) | `https://openrouter.ai/api/v1` | [Official quickstart](https://github.com/OpenRouterTeam/docs/blob/main/quickstart.mdx) |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | [Official regional endpoints](https://www.alibabacloud.com/help/en/model-studio/regions). Beijing DashScope remains supported for existing integrations; workspace-specific endpoints are recommended. UI explicitly asks users to match their key's region/workspace. |
| xAI | `https://api.x.ai/v1` | [Official text generation guide](https://docs.x.ai/developers/model-capabilities/text/generate-text) |
| Mistral AI | `https://api.mistral.ai/v1` | [Official chat API](https://docs.mistral.ai/api/endpoint/chat) |
| Groq | `https://api.groq.com/openai/v1` | [Official compatibility guide](https://console.groq.com/docs/openai) |
| SiliconFlow | `https://api.siliconflow.cn/v1` | [Official chat API](https://docs.siliconflow.cn/docs/api/chat-completions-post) |

Preset models are starting suggestions, not account entitlement or live availability checks. In particular, Raytone's suggested `deepseek-v4-pro` has not been validated with an account. Use Fetch models or enter the exact account model ID. Existing configured model choices were not migrated or changed. CLI protocol restrictions remain unchanged; adding an OpenAI-compatible preset does not promise Anthropic/Responses support for every engine.

## Verification

- Build passed; only the existing large-chunk warning.
- Before commit, exported only the provider changes onto HEAD into a temporary tree: build and all 37 provider/store/probe/sync/browser test results passed independently of unrelated work.
- Full working-tree `npm test` file set (including pre-existing changes), run directly with `node --test --test-concurrency=2`: 1032 results, 1031 passed, 1 existing skip, 0 failures/cancellations. See `full-tests.log`.
- Provider settings/store/probe/sync: 24 checks passed, including older catalog restoration, Raytone save, preserved selection, and endpoint-bound dummy credentials.
- Browser picker: 12 locale/viewport/theme combinations passed (13 test results including the parent). Search, empty results, local logo loading, keyboard add/focus, discard, explicit save and input clearing; no horizontal overflow or page errors. Screenshots `catalog-*.png`.
- Existing fixture picker: 40 desktop/mobile scenarios passed, no startup/fatal/scenario failures. See `fixture-results.json`.
- Isolated `npm run check:local` passed (no model request), and `node scripts/cloud-preview.mjs --check` passed.

No deployment, Git push, real account/key use, or paid inference. The pre-existing unrelated workspace changes were preserved.
