// A temporary SVG redraw of the selected concept. Production avatar files stay untouched.
export const kinds = ['woman', 'man', 'boy'];
export const names = { woman: 'Raer', man: 'Tonny', boy: 'Bob' };
const navy = '#0C2458', gold = '#E7AC26', blue = '#1B3971';
const skin = '#F8E7CF', edge = '#C9A47E';

function face(wide) {
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

const artwork = {
  woman: {
    body: `<path d="M17 76C8 44 22 15 50 14C78 15 92 44 83 76C81 82 74 82 73 77V52H27V77C26 82 19 82 17 76Z" fill="${navy}"/>
      ${face(false)}
      <path d="M23 52C21 30 35 18 52 18C69 18 80 30 78 49C69 47 61 39 57 30C51 41 38 48 23 52Z" fill="${navy}"/>
      <path d="M55 20C65 21 73 27 76 36C69 34 62 30 58 25Z" fill="${blue}"/>
      <path d="M21 44Q20 22 42 16" stroke="${gold}" stroke-width="2.2" stroke-linecap="round"/>
      <g stroke="${gold}" stroke-width="2.3" stroke-linecap="round"><path d="M69 34L75 31M70 38L76 35M71 42L77 39"/></g>
      <ellipse cx="20" cy="59" rx="6.5" ry="8.6" fill="#FFF"/>
      <g stroke="${gold}" stroke-width="2.5" stroke-linecap="round"><path d="M18 52H22M16 55.5H24M15.5 59H24.5M16 62.5H24M18 66H22"/></g>
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
      <rect x="26" y="46.5" width="23" height="27" rx="5"/><rect x="51" y="46.5" width="23" height="27" rx="5"/>
      <path d="M49 53Q50 51 51 53M26 54H18M74 54H82"/>
      </g><g stroke="${gold}" stroke-width="1.6" stroke-linecap="round"><path d="M19 51H25M19 54H25M19 57H25M75 51H81M75 54H81M75 57H81"/></g>
      <g class="glint" stroke="#FFF" stroke-width="1.6" stroke-linecap="round"><path d="M30 66L34 52M55 66L59 52"/></g>${mouth()}`,
    height: 72,
  },
  boy: {
    body: `${face(true)}
      <path d="M21 56C17 37 25 23 49 24C76 24 86 37 80 56L75 50L73 44L68 48L62 42L36 42L30 49L27 46L25 56Z" fill="${navy}"/>
      <g transform="translate(0 -2)"><ellipse cx="43" cy="13" rx="4" ry="2.5" fill="${navy}"/>
      <path d="M17 47C15 26 30 13 52 13C72 13 84 28 83 41L83 46L28 49L18 51Z" fill="${navy}"/>
      <path d="M20 39Q23 22 42 16L33 27L26 44Z" fill="${blue}"/>
      <path d="M29 46Q56 44 76 40Q90 39 95 46Q96 50 89 50Q76 45 65 49Q43 55 29 46Z" fill="${blue}"/>
      <path d="M30 47Q46 51 66 46Q82 40 93 46" stroke="${gold}" stroke-width="1.2" stroke-linecap="round"/>
      <g stroke="${gold}" stroke-width="2.1" stroke-linecap="round"><path d="M53 27H60M50 31H63M53 35H60"/></g></g>`,
    over: mouth(), height: 77.5,
  },
};

export function avatarSVG(kind, { ratio = .24, halo = true, id = kind, pose = null } = {}) {
  const part = artwork[kind];
  const height = ratio === 0 ? 13.5 : part.height * ratio;
  const width = ratio === 0 ? 6.2 : 6.6;
  const eyes = [38.5, 61.5].map(x => `<g transform="translate(${x} ${kind === 'boy' ? 60.5 : 59.5})"><g class="blink"${pose ? ` transform="scale(1 ${pose.blink})"` : ''}><g class="expression">
    <rect class="open-eye" x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" rx="${width / 2}" fill="${navy}"/>
    <path class="happy-eye" d="M-5.2 1Q0-6.4 5.2 1" stroke="${navy}" stroke-width="3.4" stroke-linecap="round"/>
  </g></g></g>`).join('');
  const rays = [14,23,32,41,50,59,68,77,86].map((y,i) => {
    const half = Math.sqrt(46 ** 2 - (y - 52) ** 2);
    const splits = [.62,.56,.66,.58,.64,.56,.66,.6,.64];
    const start = 50 - half + 2 * half * splits[i] + 2;
    const drift = pose ? 0.7 - .7 * Math.cos((pose.t / 6 + i * .075) * Math.PI * 2) : 0;
    return `<line class="ray" style="--i:${i}" x1="${start}" x2="${50+half}" y1="${y}" y2="${y}" stroke="${gold}" stroke-width="3.4" stroke-linecap="round" transform="translate(${drift} 0)"/>`;
  }).join('');
  const clip = `lenses-${id}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" fill="none" aria-hidden="true">
    ${kind === 'man' ? `<defs><clipPath id="${clip}"><rect x="108" y="190" width="84" height="100" rx="15"/><rect x="208" y="190" width="84" height="100" rx="15"/></clipPath></defs>` : ''}
    ${halo ? `<g class="halo" transform="scale(4)" opacity=".55">${rays}</g>` : ''}
    <g class="drag-group"><g class="follow-group"${pose ? ` transform="translate(${pose.x/2.4} ${pose.y/3}) rotate(${pose.turn} 200 235)"` : ''}><g class="action-group"><g class="gesture-group"><g class="breath">
    <g transform="scale(4)">${part.body}</g>
    <g${kind === 'man' ? ` clip-path="url(#${clip})"` : ''}><g class="gaze"${pose ? ` transform="translate(${pose.x} ${pose.y})"` : ''}><g class="thinking-gaze"><g transform="scale(4)">${eyes}</g></g></g></g>
    <g transform="scale(4)">${part.over}</g>
    </g></g></g></g></g></svg>`;
}
