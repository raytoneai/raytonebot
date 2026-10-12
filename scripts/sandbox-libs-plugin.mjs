import { rolldown } from 'rolldown';

/**
 * Libraries an HTML artifact may use (ADR-035). The artifact frame has no network, so the page
 * inlines each library's code into the frame. This plugin turns `virtual:sandbox-lib/<name>`
 * into a lazy chunk holding one minified classic script (IIFE) that sets the usual global and
 * records the module namespace for the import-map shims built in `outputframe/sandboxLibs.ts`.
 * Bundling here, rather than shipping the packages' own builds, gives three (which has no
 * single-file build any more) the same shape as the others.
 */
export const SANDBOX_LIBS = {
  three: { modules: ['three'], global: 'THREE = M.three', notice: 'three.js | MIT | Copyright 2010-2025 three.js authors' },
  d3: { modules: ['d3'], global: 'd3 = M.d3', notice: 'D3 | ISC | Copyright 2010-2023 Mike Bostock' },
  chart: { modules: ['chart.js', 'chart.js/auto'], global: 'Chart = M["chart.js/auto"].default', notice: 'Chart.js | MIT | Copyright 2014-2024 Chart.js Contributors' },
  gsap: { modules: ['gsap'], global: 'gsap = M.gsap.gsap', notice: 'GSAP | Standard no-charge license, https://gsap.com/standard-license | Copyright 2008-2025 GreenSock, Inc.' },
};

const PREFIX = 'virtual:sandbox-lib/';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

async function bundle(name) {
  const lib = SANDBOX_LIBS[name];
  const specifiers = lib.modules;
  const entry = [
    ...specifiers.map((specifier, i) => `import * as m${i} from ${JSON.stringify(specifier)};`),
    `const M = {${specifiers.map((specifier, i) => `${JSON.stringify(specifier)}: m${i}`).join(', ')}};`,
    'const store = (window.__raytoneLibs = window.__raytoneLibs || {});',
    'Object.assign(store, M);',
    `window.${lib.global};`,
  ].join('\n');
  const build = await rolldown({
    input: 'sandbox-entry',
    platform: 'browser',
    plugins: [{ name: 'sandbox-entry', resolveId: (id) => (id === 'sandbox-entry' ? id : null), load: (id) => (id === 'sandbox-entry' ? entry : null) }],
  });
  const { output } = await build.generate({ format: 'iife', minify: true, banner: `/*! ${lib.notice} */` });
  await build.close();
  // The export names a bare `import { x } from "<specifier>"` can ask for, read from the package itself.
  const exports = {};
  for (const specifier of specifiers) {
    exports[specifier] = Object.keys(await import(specifier)).filter((key) => key !== 'default' && IDENTIFIER.test(key));
  }
  return { code: output[0].code, exports };
}

export function sandboxLibsPlugin() {
  const cache = new Map();
  return {
    name: 'raytonebot-sandbox-libs',
    resolveId(id) {
      return id.startsWith(PREFIX) && id.slice(PREFIX.length) in SANDBOX_LIBS ? `\0${id}` : null;
    },
    async load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return null;
      const name = id.slice(PREFIX.length + 1);
      if (!cache.has(name)) cache.set(name, bundle(name));
      const { code, exports } = await cache.get(name);
      return `export const code = ${JSON.stringify(code)};\nexport const exports = ${JSON.stringify(exports)};\n`;
    },
  };
}
