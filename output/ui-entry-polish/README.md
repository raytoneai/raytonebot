# 2026-10-19 UI and invitation verification

- `invite-entry-final.png`: final conversation header invitation menu, real local UI, no member mutation.
- `desktop-light.png`, `artifacts-final.png`, `artifacts-dark.png`: compact artifact rows in the actual output panel, 12.5px text / 36px rows.
- `custom-invite.png`, `invite-narrow.png`: custom Bot membership UI and 390px menu using an isolated member API response; original Bot configuration and IndexedDB drafts were restored. The actual HTTP endpoint is separately covered in `groupLifecycle.test.ts` with temporary storage.
- `fixtures-final.json`: all 20 devtools scenarios rendered; 1440px content/viewport widths match; no console errors. This checks rendering, not every fixture's tool actions.
- Resend was clicked twice after an injected provider configuration failure; both reached the configuration check without creating a history branch or calling a model.
- Automated checks: 411 tests, build and local health check. Runtime tests use real controller/storage/HTTP with a controlled engine, including preserved conversation identity/context, custom Bot identities, restart, request deduplication and approvals.

No external model calls, deployment or push. Narrow-screen artifact layout was not verified; `artifacts-narrow*.png` are exploratory chat screenshots, not artifact layout evidence.
