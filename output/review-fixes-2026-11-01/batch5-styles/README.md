# Batch 5 CSS cascade comparison

`compare-styles.mjs` compares the complete CSS sources at `HEAD` with the current working tree. It runs an isolated markup probe using the repository's `findHeadlessShell()` and locally installed `playwright-core`; no live dev server or handcrafted cascade overrides are used.

Run from the repository root:

```sh
node output/review-fixes-2026-11-01/batch5-styles/compare-styles.mjs baseline
node output/review-fixes-2026-11-01/batch5-styles/compare-styles.mjs working
```

The 16 contexts cover bare and `.preview-frame` markup, widths 1280 and 390, light/dark token values, and native/illustrated style attributes. The probe includes completed and failed step icons, SVG stroke width, error layout, and composer surface. Results are saved as `baseline-complete-css.json` and `working-complete-css.json`; matching screenshots use those prefixes. The comparison inspected 3,696 computed property values with zero mismatches. All 16 screenshot pairs are pixel-identical.

The earlier `before.json` and `before-*.png` files preserve the initial real-app preview capture made before edits. This isolated probe checks CSS cascade behavior with representative markup; it does not replace the app's devtools fixture run or exercise interactive states.
