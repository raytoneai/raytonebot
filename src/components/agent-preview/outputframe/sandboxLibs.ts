/**
 * Libraries an HTML artifact can use without network (ADR-035): the ones a page refers to are
 * loaded here as lazy chunks and inlined into its frame. A page may use the globals (THREE, d3,
 * Chart, gsap) or bare imports in a module script; an import map points each specifier at a
 * data: shim that re-exports the namespace the library's script recorded.
 */
export type SandboxLib = { name: SandboxLibName; code: string; exports: Record<string, string[]> };
export type SandboxLibName = "three" | "d3" | "chart" | "gsap";

const USES: Record<SandboxLibName, RegExp> = {
  three: /\bTHREE\.|["']three["']/,
  d3: /\bd3\.|["']d3["']/,
  chart: /\bnew\s+Chart\s*\(|\bChart\.(register|defaults)|["']chart\.js(\/auto)?["']/,
  gsap: /\bgsap\.|["']gsap["']/,
};

const LOADERS: Record<SandboxLibName, () => Promise<{ code: string; exports: Record<string, string[]> }>> = {
  three: () => import("virtual:sandbox-lib/three"),
  d3: () => import("virtual:sandbox-lib/d3"),
  chart: () => import("virtual:sandbox-lib/chart"),
  gsap: () => import("virtual:sandbox-lib/gsap"),
};

export function sandboxLibsUsed(body: string): SandboxLibName[] {
  return (Object.keys(USES) as SandboxLibName[]).filter((name) => USES[name].test(body));
}

export async function loadSandboxLibs(names: readonly SandboxLibName[]): Promise<SandboxLib[]> {
  return Promise.all(names.map(async (name) => {
    const { code, exports } = await LOADERS[name]();
    return { name, code, exports };
  }));
}

/** An import map, then each library as a classic script; both must precede the page's own scripts. */
export function sandboxLibsHead(libs: readonly SandboxLib[]): string {
  if (!libs.length) return "";
  const imports: Record<string, string> = {};
  for (const lib of libs) {
    for (const [specifier, names] of Object.entries(lib.exports)) {
      const source = `const m=window.__raytoneLibs[${JSON.stringify(specifier)}];export default m.default??m;export const {${names.join(",")}}=m;`;
      imports[specifier] = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
    }
  }
  const map = JSON.stringify({ imports }).replace(/</g, "\\u003c");
  return `<script type="importmap">${map}</script>${libs.map((lib) => `<script>${lib.code.replace(/<\/script/gi, "<\\/script")}</script>`).join("")}`;
}
