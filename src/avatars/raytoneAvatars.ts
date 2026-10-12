// Approved Raytone character study: warm contours, larger eyes and one gold accessory per role.
const navy = '#0C2458', gold = '#E7AC26', blue = '#1B3971';
const skin = '#F8E7CF', edge = '#C9A47E';
export const characters = {
  woman: { name: 'Raer', note: '助理 · 耳麦' },
  man: { name: 'Tonny', note: '规划评审 · 方眼镜与铅笔' },
  boy: { name: 'Bob', note: '动手实现 · 棒球帽' },
} as const;
export type AvatarKind = keyof typeof characters;
/** The gold half of the Raytone mark: rows of a circle, each starting where navy would end. */
function halo(): string {
  const ys = [14, 23, 32, 41, 50, 59, 68, 77, 86];
  const splits = [.62, .56, .66, .58, .64, .56, .66, .6, .64];
  return ys.map((y, i) => {
    const half = Math.sqrt(46 ** 2 - (y - 52) ** 2);
    const start = 50 - half + 2 * half * splits[i] + 2;
    return `<line class="ray" style="--i:${i}" x1="${start.toFixed(1)}" y1="${y}" x2="${(50 + half).toFixed(1)}" y2="${y}" stroke="${gold}" stroke-width="3.4" stroke-linecap="round"/>`;
  }).join('');
}

function face(wide: boolean): string {
  // One joined outline avoids lines showing through where the ears meet the cheeks.
  return `${wide
    ? `<path d="M22 45Q24 29 50 29Q76 29 78 45L79 54C87 52 88 67 79 67C76 78 66 86 50 86C34 86 24 78 21 67C12 67 13 52 21 54Z" fill="${skin}" stroke="${edge}" stroke-width=".7"/>`
    : `<ellipse cx="50" cy="57" rx="27" ry="29" fill="${skin}" stroke="${edge}" stroke-width=".7"/>`}
    <g fill="#F4C7A7" opacity=".7"><ellipse cx="33" cy="72" rx="4.5" ry="2.1"/><ellipse cx="67" cy="72" rx="4.5" ry="2.1"/></g>`;
}

function mouth(y = 78) {
  return `<g transform="translate(50 ${y})"><g class="mouth">
    <path class="m-smile" d="M-4 -1Q0 3 4 -1" stroke="${navy}" stroke-width="1.7" stroke-linecap="round"/>
    <path class="m-flat" d="M-2.6 0H2.6" stroke="${navy}" stroke-width="1.7" stroke-linecap="round"/>
    <ellipse class="m-o" rx="1.7" ry="2.1" fill="${navy}"/>
    <path class="m-open" d="M-4.4 -1.4Q0 -1.9 4.4 -1.4Q3.6 5 0 5Q-3.6 5 -4.4 -1.4Z" fill="${navy}"/>
    <path class="m-frown" d="M-3.4 1.6Q0 -1.6 3.4 1.6" stroke="${navy}" stroke-width="1.7" stroke-linecap="round"/>
  </g></g>`;
}

const parts: Record<AvatarKind, { body: string; over: string; height: number }> = {
  woman: {
    body: `<path d="M17 76C8 44 22 15 50 14C78 15 92 44 83 76C81 82 74 82 73 77V52H27V77C26 82 19 82 17 76Z" fill="${navy}"/>
      ${face(false)}
      <path d="M23 52C21 30 35 18 52 18C69 18 80 30 78 49C69 47 61 39 57 30C51 41 38 48 23 52Z" fill="${navy}"/>
      <path d="M55 20C65 21 73 27 76 36C69 34 62 30 58 25Z" fill="${blue}"/>
      <path d="M21 44Q20 22 42 16" stroke="${gold}" stroke-width="2.2" stroke-linecap="round"/>

      <ellipse cx="20" cy="59" rx="6.5" ry="8.6" fill="#FFF"/>
      <g stroke="${gold}" stroke-width="2.5" stroke-linecap="round"><path d="M17 55H23M15.5 59H24.5M17 63H23"/></g>
      <path d="M21.5 66Q23 73 33 74" stroke="${gold}" stroke-width="2" stroke-linecap="round"/>
      <circle class="mic" cx="34" cy="74" r="2.2" fill="${gold}"/>`,
    over: mouth(), height: 72,
  },
  man: {
    body: `${face(true)}
      <path d="M20 53C17 28 31 14 51 14C72 14 85 28 81 53L77 46C76 38 71 34 64 31C53 35 37 35 27 41C24 45 23 49 23 53Z" fill="${navy}"/>
      <path d="M38 18C50 15 64 16 72 23C62 23 51 24 42 28Z" fill="${blue}"/>
      <path d="M21 45V56M79 45V56" stroke="#9AAAC3" stroke-width="4" stroke-linecap="round"/>
      <path d="M78 41L89 27" stroke="${gold}" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M89 27L91 24.6" stroke="${navy}" stroke-width="3.4" stroke-linecap="round"/>`,
    over: `<g stroke="${navy}" stroke-width="2.1">
      <rect x="27.5" y="47" width="21" height="25" rx="4.5"/><rect x="51.5" y="47" width="21" height="25" rx="4.5"/>
      <path d="M48.5 53Q50 51 51.5 53M27.5 54H18M72.5 54H82"/>
      </g>
      <g class="glint" stroke="#FFF" stroke-width="1.6" stroke-linecap="round"><path d="M30 66L34 52M55 66L59 52"/></g>${mouth()}`,
    height: 72,
  },
  boy: {
    body: `${face(true)}
      <path d="M21 56C17 37 25 23 49 24C76 24 86 37 80 56L75 50L73 44L68 48L62 42L36 42L30 49L27 46L25 56Z" fill="${navy}"/>
      <g transform="translate(0 -6)"><ellipse cx="43" cy="13" rx="4" ry="2.5" fill="${navy}"/>
      <path d="M17 47C15 26 30 13 52 13C72 13 84 28 83 41L83 46L28 49L18 51Z" fill="${navy}"/>
      <path d="M20 39Q23 22 42 16L33 27L26 44Z" fill="${blue}"/>
      <path d="M29 46Q56 44 76 40Q90 39 95 46Q96 50 89 50Q76 45 65 49Q43 55 29 46Z" fill="${blue}"/>

      <g stroke="${gold}" stroke-width="2.1" stroke-linecap="round"><path d="M53 27H60M50 31H63M53 35H60"/></g></g>`,
    over: mouth(), height: 77.5,
  },
};

export function avatarSVG(kind: AvatarKind, compact = false, withHalo = true, id: string = kind): string {
  const { body, over, height } = parts[kind];
  const eyeHeight = height * .24;
  const eyes = [38.5, 61.5].map(x => `<g transform="translate(${x} ${kind === 'boy' ? 60.5 : 59.5})"><g class="blink"><g class="expression">
    <rect class="open-eye" x="-3.3" y="${-eyeHeight / 2}" width="6.6" height="${eyeHeight}" rx="3.3" fill="${navy}"/>
    <path class="happy-eye" d="M-5.2 1Q0-6.4 5.2 1" stroke="${navy}" stroke-width="3.4" stroke-linecap="round"/>
  </g></g></g>`).join('');
  const clip = `lenses-${id}`;
  const haloScale = compact ? 'translate(200 200) scale(3.36) translate(-50 -50)' : 'scale(4)';
  return `<svg viewBox="${compact ? '40 24 320 320' : '0 0 400 400'}" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    ${kind === 'man' ? `<defs><clipPath id="${clip}"><rect x="114" y="192" width="76" height="92" rx="14"/><rect x="210" y="192" width="76" height="92" rx="14"/></clipPath></defs>` : ''}
    ${withHalo ? `<g class="halo" transform="${haloScale}" opacity=".55">${halo()}</g>` : ''}
    <g class="drag-group"><g class="follow-group"><g class="action-group"><g class="gesture-group"><g class="breath">
      <g transform="scale(4)">${body}</g>
      <g${kind === 'man' ? ` clip-path="url(#${clip})"` : ''}><g class="gaze"><g class="thinking-gaze"><g transform="scale(4)">${eyes}</g></g></g></g>
      <g transform="scale(4)">${over}</g>
    </g></g></g></g></g></svg>`;
}
