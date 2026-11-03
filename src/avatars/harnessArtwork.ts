import type { AgentHarnessId } from '../pi/harnessCatalog.ts';
import { material, relief } from './avatarMaterials.ts';

/** Original publisher assets; provenance is in public/brand/harness/README.md. */
export function harnessLogo(harness: AgentHarnessId, surface: 'tile' | 'lens' = 'tile'): string {
  const file = surface === 'lens' && (harness === 'codex' || harness === 'dsh') ? `${harness}-lens.svg`
    : harness === 'codex' ? 'codex.png' : `${harness}.svg`;
  const base = import.meta.env?.BASE_URL ?? './';
  const bounds = surface === 'lens' ? 'x="55.5" y="45.5" width="24" height="20"' : 'width="24" height="24"';
  return `<image href="${base}brand/harness/${file}" ${bounds} preserveAspectRatio="xMidYMid meet"/>`;
}

export function harnessMarkSVG(harness: AgentHarnessId, id: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <defs>${material(`${id}-plate`, '#F2ECDD')}${relief(`${id}-relief`)}</defs>
    <rect x="2" y="3" width="28" height="27" rx="8" fill="#86765c" opacity=".25"/>
    <rect x="2" y="1.5" width="28" height="27" rx="8" fill="url(#${id}-plate)" stroke="#fff6e3" stroke-width=".7"/>
    <g transform="translate(4 3)" filter="url(#${id}-relief)">${harnessLogo(harness)}</g>
  </svg>`;
}
