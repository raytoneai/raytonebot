// Raytone character avatars, redrawn per role (output/raytone-avatars/redesign, 2026-10-10):
// one illustrated language for the three, a gold ray halo from the Raytone mark, and one prop
// that says what each one does.
const navy = '#0C2458', gold = '#E7AC26', highlight = '#1B3971', grey = '#9AAAC3',
  // Warm enough to hold its edge on a white page without an outline, plate or shadow.
  skin = '#FCEEDC';

export const characters = {
  woman: { name: 'Raer', note: '助理 · 耳麦' },
  man: { name: 'Tonny', note: '规划评审 · 方眼镜与铅笔' },
  boy: { name: 'Bob', note: '动手实现 · 汗带' },
} as const;

// Geometry is drawn in a 100-unit box and scaled ×4 into the 400 view box, so the motion
// layers (gaze, poses, gestures; see avatarMotion.ts) keep their 400-unit distances.
export type AvatarKind = keyof typeof characters;

/** The gold half of the Raytone mark: rows of a circle, each starting where navy would end. */
function halo(): string {
  const ys = [14, 23, 32, 41, 50, 59, 68, 77, 86];
  const splits = [.62, .56, .66, .58, .64, .56, .66, .6, .64];
  return ys.map((y, i) => {
    const half = Math.sqrt(46 ** 2 - (y - 52) ** 2);
    const start = 50 - half + 2 * half * splits[i] + 2;
    return `<line class="ray" style="--i:${i}" x1="${start.toFixed(1)}" y1="${y}" x2="${(50 + half).toFixed(1)}" y2="${y}" stroke="${gold}" stroke-width="4.4" stroke-linecap="round"/>`;
  }).join('');
}

function face(wide: boolean): string {
  const ears = wide ? `<ellipse cx="19.5" cy="59" rx="4" ry="5.5" fill="${skin}"/><ellipse cx="80.5" cy="59" rx="4" ry="5.5" fill="${skin}"/>` : '';
  const cheek = wide ? 32 : 34;
  return `${ears}<ellipse cx="50" cy="57" rx="${wide ? 30 : 27}" ry="28" fill="${skin}"/>
    <g fill="#F2C3A8" opacity=".5"><ellipse cx="${cheek}" cy="67" rx="4.2" ry="2.3"/><ellipse cx="${100 - cheek}" cy="67" rx="4.2" ry="2.3"/></g>`;
}

/** One shape per state; raytoneAvatar.css shows the right one. */
function mouth(y: number): string {
  return `<g transform="translate(50 ${y})"><g class="mouth">
    <path class="m-smile" d="M-4 -1Q0 3 4 -1" stroke="${navy}" stroke-width="1.7" stroke-linecap="round"/>
    <path class="m-flat" d="M-2.6 0H2.6" stroke="${navy}" stroke-width="1.7" stroke-linecap="round"/>
    <ellipse class="m-o" rx="1.7" ry="2.1" fill="${navy}"/>
    <path class="m-open" d="M-4.4 -1.4Q0 -1.9 4.4 -1.4Q3.6 5 0 5Q-3.6 5 -4.4 -1.4Z" fill="${navy}"/>
    <path class="m-frown" d="M-3.4 1.6Q0 -1.6 3.4 1.6" stroke="${navy}" stroke-width="1.7" stroke-linecap="round"/>
  </g></g>`;
}

const eyes = [41, 59].map(x => `<g transform="translate(${x} 58)"><g class="blink"><g class="expression">
    <rect class="open-eye" x="-3.1" y="-6.75" width="6.2" height="13.5" rx="3.1" fill="${navy}"/>
    <path class="happy-eye" d="M-6.2 1Q0-7.4 6.2 1" stroke="${navy}" stroke-width="4.6" stroke-linecap="round"/>
  </g></g></g>`).join('');

// The two men's hair and props are drawn narrow and widened with the face.
const widen = 'matrix(1.1 0 0 1 -5 0)';

const parts: Record<AvatarKind, { body: string; over: string }> = {
  // Raer, the assistant and group PM: a soft bob, side-swept fringe, a gold single-ear headset.
  woman: {
    body: `<path d="M17 76C8 44 22 15 50 14C78 15 92 44 83 76C81 82 74 82 73 77V52H27V77C26 82 19 82 17 76Z" fill="${navy}"/>
      ${face(false)}
      <path d="M23 52C21 30 35 18 52 18C69 18 80 30 78 49C69 47 61 39 57 30C51 41 38 48 23 52Z" fill="${navy}"/>
      <path d="M55 20C65 21 73 27 76 36C69 34 62 30 58 25Z" fill="${highlight}"/>
      <path d="M21 44Q20 22 42 16" stroke="${gold}" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="17.5" y="51" width="8" height="12" rx="4" fill="${gold}"/>
      <path d="M21.5 62Q23 72 33 73" stroke="${gold}" stroke-width="2" stroke-linecap="round"/>
      <circle class="mic" cx="34" cy="73" r="2.2" fill="${gold}"/>`,
    over: mouth(71),
  },
  // Tonny, the planner and reviewer: a neat side part, grey temples, square glasses, a pencil.
  man: {
    body: `${face(true)}<g transform="${widen}">
      <path d="M22 52C19 28 33 14 51 14C70 14 82 28 79 52L75 47C74 39 70 34 63 31C53 35 39 35 29 41C26 44 25 48 25 52Z" fill="${navy}"/>
      <path d="M40 18C50 15 62 16 70 22C62 23 52 24 44 27Z" fill="${highlight}"/>
      <path d="M22.5 44V56M77.5 44V56" stroke="${grey}" stroke-width="4" stroke-linecap="round"/>
      <path d="M75 42L88 27" stroke="${gold}" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M88 27L90 24.6" stroke="${navy}" stroke-width="3.4" stroke-linecap="round"/></g>`,
    over: `<g stroke="${navy}" stroke-width="2"><rect x="31" y="50" width="19" height="16" rx="4"/><rect x="50" y="50" width="19" height="16" rx="4"/><path d="M31 54H20M69 54H80"/></g>
      <g class="glint" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M36 63L42 52M55 63L61 52"/></g>
      ${mouth(73)}`,
  },
  // Bob, the builder: spiky hair under a gold sweatband whose tails fly while he works.
  boy: {
    body: `${face(true)}<g transform="${widen}">
      <path d="M21 56C15 30 30 11 52 11C74 11 86 30 80 56L75 48L71 39L64 43L58 35L50 41L42 34L34 42L27 42Z" fill="${navy}"/>
      <path d="M36 17L39 5L46 13L54 2L58 12L67 6L66 17Z" fill="${navy}"/>
      <path d="M52 11C66 12 76 20 80 30L72 27L66 30L60 22Z" fill="${highlight}"/>
      <path d="M23 43Q50 31 78 43L78.5 49Q50 38 22.5 49Z" fill="${gold}"/>
      <path d="M33 41.5H43M48 39.5H56" stroke="${navy}" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
      <g class="tails"><path d="M23 45L11 40L14 47Z M23 47L12 52L17 55Z" fill="${gold}"/></g></g>`,
    over: mouth(72),
  },
};

/**
 * `compact` is for small faces (sidebar, transcript, header): the view box crops the margin
 * and the halo draws in closer, so the face fills about as much of its box as the user's own
 * round avatar does. The large welcome face keeps the full composition. Without `halo` (the
 * smallest faces, repeated down a list) the gold rays are left out, so the list is not striped.
 */
export function avatarSVG(kind: AvatarKind, compact = false, withHalo = true): string {
  const { body, over } = parts[kind];
  const haloScale = compact ? 'translate(200 200) scale(3.36) translate(-50 -50)' : 'scale(4)';
  return `<svg viewBox="${compact ? '40 24 320 320' : '0 0 400 400'}" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    ${withHalo ? `<g class="halo" transform="${haloScale}">${halo()}</g>` : ''}
    <g class="drag-group"><g class="follow-group"><g class="action-group"><g class="gesture-group"><g class="breath">
      <g transform="scale(4)">${body}</g>
      <g class="gaze"><g class="thinking-gaze"><g transform="scale(4)">${eyes}</g></g></g>
      <g transform="scale(4)">${over}</g>
    </g></g></g></g></g></svg>`;
}
