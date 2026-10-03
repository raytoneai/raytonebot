# Raytone animated avatar study

Run `npm run dev` from the RaytoneBot project, then open:

http://127.0.0.1:5188/output/raytone-avatars/animated/

This is an independent interactive prototype, not a change to the composed Agent UI.
Its four SVG characters are simplified vector redraws of the existing Raytone PNG
concepts. The original PNGs remain the visual references; this is not pixel-exact
vector tracing. Eyes, eyelids, glasses, hair and brand accents are separate layers.

## Implemented

- Four character variants with round, rectangular or oval spectacles.
- Automatic blinks, fine-pointer gaze/head following, press and bounded drag.
- Spring return using the project's existing `motion` dependency.
- Idle, waiting, success, confirmation and sleep states.
- A cancellable simulated waiting → success → idle sequence.
- Keyboard activation, visible focus, state announcements, OS/manual reduced motion.
- Animation suspension in background tabs and cleanup on character changes/page exit.

`mountMotion(element)` in `motion.js` accepts an element containing `avatarSVG(kind)`.
It returns `setState`, `setFollow`, `setReduced` and `destroy`. State changes emit an
`avatar-state` DOM event. The demo has no real Agent event subscription yet.
Before product integration, map the existing runtime status into `setState` at an
approved avatar extension point, and call `destroy` when the avatar unmounts.

## Check

Open the same URL with `?check=1`. The in-browser self-check verifies all character
eye layers, state interruption, reduced motion, invalid input, delayed callback
cleanup and cancellation when switching characters. Results appear below the demo.

The Vite development server serves this standalone prototype. The existing main-app
production build does not include the output folder as an application entry point.

## Reference

Interaction reference: [CX ArtLab / Agent Robot Avatar](https://github.com/CX-ArtLab/agent-robot-avatar),
version 0.4.3 inspected on 2026-10-03. Its SVG + state-driven interaction approach
informed this study. No upstream source or robot artwork is included in this prototype.
