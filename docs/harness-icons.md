# Harness product marks

`src/components/shell/HarnessMark.tsx` renders the client identity, independently of the selected model. The sidebar, conversation header and member menu share it. The DSH whale path lives in `src/avatars/brandMarks.ts`.

- Pi: existing mark from https://pi.dev/.
- Claude Code: orange pixel Clawd, from [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/claudecode-color.svg).
- Codex: blue terminal product mark, from [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/codex-color.svg); checked against the installed Codex app icon. Each inline gradient has a React-generated ID to avoid collisions.
- DeepSeek Harness: black whale from the official repository's `apps/web/public/favicon.svg`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`; dark mode uses the official white variant. Source: https://github.com/deepseek-ai/deepseek-harness.

Imported on 2026-10-19. SVG paths are bundled locally, without runtime external requests. Trademark rights remain with their respective owners.

## Lobe Icons license

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness license

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
