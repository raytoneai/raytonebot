# 3D Bot avatars and single-lens Harness sunglasses · 2026-11-03

The existing SVG avatar/editor now shares shaded, editable materials and offers 7 faces, 12 hairstyles (including none), and 14 accessories (including none). Added hairstyles: crew cut, textured crop, curls, curtain part, ponytail and wavy long hair. Added faces: wide round, heart, pear and soft angular. Added accessories: long scarf, neckerchief, bow tie, flower and sunglasses. Existing defaults, saved colours, gaze, blink and motion layers remain compatible. Hats clip the hair crown.

The user selected transparent artwork filling the right lens, with the frame and glass reflection retained. The avatar and thumbnail share the same renderer and unique clip IDs. Bot preset identity selects Pi, Claude Code, Codex or DSH, including in groups; DSH does not inherit Pi's logo merely because they share a face. The independent Harness tile keeps its original files. Official sources and the transparent Codex/ivory DSH derivatives are documented in [asset provenance](../../public/brand/harness/README.md).

The initial battle flags were removed at the user's request. Legacy surplus flag fields are ignored; no new persistence field, component, route, service or dependency is needed.

Validation: production build and 23 targeted appearance/profile tests passed, covering all 1176 combinations, safe configuration roundtrips, single-lens clipping, independent local IDs and original tile assets. The preceding accessory integration passed the complete suite with concurrency 2 (1001 passed, 1 skipped); default-concurrency browser timeouts in earlier iterations were retained locally, with no deadlines enlarged or checks disabled. The final visual refinement reran build and targeted checks.

The isolated commit snapshot was additionally rebuilt and all 23 targeted tests passed before committing.

Actual isolated Chrome checks covered editor selection, save/reload and restoring defaults, four-engine logo switching, desktop and 390px controls (minimum accessory width about 59px, no horizontal overflow). The final renderer and Codex editor were visually checked again. No production Bot data was changed, no real model was called, and no deployment or push occurred. Full transient logs, screenshots and A/B exploration remain local.

[Selected design](selected.png) · [Actual-renderer preview](preview.html)
