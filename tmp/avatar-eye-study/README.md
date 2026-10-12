# Raytone eye proportion study

Open http://127.0.0.1:5188/tmp/avatar-eye-study/ with the existing Vite server running.

- Temporary SVG redraw of the chosen accessory / fine warm contour concept. Bob wears the navy cap with three gold bars.
- Eyes default to 24% of the full head silhouette: 17.28 units for Raer / Tonny and 18.6 for Bob. Capsule width is 6.6 units. The preview offers 23%, 24% and 25%.
- Tonny's frames shrink from 34 to 27 units tall, with the mouth restored to its usual position. The lens clipping follows the smaller frames. Bob's cap moves 4 units back down. Asking/listening retain clearance without stretching the eyes vertically.
- The HTML imports the existing `src/avatars/avatarMotion.ts` and `raytoneAvatar.css` directly. State motion, mouse gaze, blinking and spring drag are reused. Reduced motion is respected. The ratio switch changes eye height only; all three options share the compact frames and selected accessories.
- `preview-24.gif`: a 6-second, 20 fps portable loop rendered from the same SVG geometry. It samples the existing idle gaze distances, 140/520 ms eye/head timing, 180 ms blink and 6-second halo drift; it is not a recording of every interactive state. The HTML offers the complete state previews. `preview.gif` is the previous 33% study.
- Only this `tmp/avatar-eye-study` directory was written. The three source avatar files were checked against `source-sha256.txt` and remained unchanged.

Verification for the 24% revision: JavaScript syntax checks; browser inspection of the default view and thinking, 23% / 24% / 25% ratio switching and autoplay; no page console errors. GIF metadata confirms 1080 × 458, 120 frames, 6 seconds and infinite looping. Source hashes remain unchanged. No production build or test suite was needed for this isolated preview.

GIF export: `node tmp/avatar-eye-study/export-gif.mjs`, then assemble the numbered PNG frames at 20 fps using ffmpeg with a generated palette. The exporter uses the local bundled Sharp dependency.
