// Raytone character avatars: layered SVG from the avatar study in
// output/raytone-avatars/animated (Codex, 2026-10-03), typed for the product.
const navy = '#0C2458', gold = '#E7AC26';

export const characters = {
  woman: { name: '圆眼镜女生', note: '轻快 · 好奇' },
  boy: { name: '短发少年', note: '活泼 · 专注' },
  man: { name: '方眼镜男士', note: '沉稳 · 可靠' },
  elder: { name: '银发女士', note: '温和 · 从容' },
} as const;

// Original layered vector interpretations of the Raytone PNG concepts.
// Separate gaze, blink, expression and glasses layers keep their transforms independent.
export type AvatarKind = keyof typeof characters;

export function avatarSVG(kind: AvatarKind): string {
  const old = kind === 'elder', man = kind === 'man', boy = kind === 'boy';
  const hair = old ? '#9AAAC3' : navy;
  const back = boy || man
    ? `<path d="M43 236C18 130 76 57 181 53C302 39 373 121 356 250L313 278H72Z" fill="${hair}"/>`
    : `<path d="M48 359C9 324 21 201 41 149C69 67 142 37 224 54C333 67 380 178 354 300C347 346 319 374 288 371L307 288H79L94 367Q66 374 48 359Z" fill="${hair}"/>`;
  const pony = kind === 'woman'
    ? `<path d="M77 133C-5 126 15 44 67 35C107 28 124 57 103 87Z" fill="${navy}"/><path d="M80 102L107 77" stroke="${gold}" stroke-width="15" stroke-linecap="round"/>`
    : old ? `<ellipse cx="52" cy="183" rx="35" ry="43" fill="#8599B5"/><path d="M53 148Q25 187 54 218" fill="none" stroke="${navy}" stroke-width="12"/>` : '';
  const face = `<ellipse cx="200" cy="239" rx="143" ry="151" fill="#FFF7E8"/>
    ${boy || man ? '<ellipse cx="57" cy="252" rx="21" ry="30" fill="#FFF7E8"/><ellipse cx="343" cy="252" rx="21" ry="30" fill="#FFF7E8"/>' : ''}
    <g fill="#EAC4A5" opacity=".48"><ellipse cx="108" cy="301" rx="18" ry="10"/><ellipse cx="291" cy="301" rx="18" ry="10"/></g>`;
  let fringe;
  if (boy) {
    fringe = `<path d="M48 225L38 164Q35 143 56 129L77 110H39Q21 104 36 90L109 86L76 70Q59 59 76 48L156 55L132 31Q122 16 141 17C230 23 323 86 354 175L344 222L317 193L300 211L281 154Q208 178 139 125Q91 156 65 220Z" fill="${navy}"/>
      <path d="M155 55Q252 56 312 136Q269 159 228 121Z" fill="#1B3971"/>`;
  } else if (man) {
    fringe = `<path d="M46 168L74 142L89 233L58 268Z M328 148L354 174L341 274L316 229Z" fill="#91A2B5"/>
      <path d="M45 162Q33 134 50 115L74 99L40 96Q25 83 44 73L120 71L79 59Q65 45 85 41C150 29 178 41 192 53C291 34 338 99 340 163L306 141L296 120Q247 150 194 121Q144 88 111 129L72 163Z" fill="${navy}"/>
      <path d="M176 55Q258 43 305 102Q255 120 219 92Z" fill="#1B3971"/>`;
  } else if (old) {
    fringe = `<path d="M50 235Q18 158 71 94C130 20 258 43 317 110Q356 144 348 229L315 199L295 154Q259 163 218 140L144 104Q100 139 65 236Z" fill="${hair}"/>
      <path d="M64 184Q107 105 166 98Q218 155 297 161Q220 164 155 126Q104 154 64 222Z" fill="${navy}"/>
      <path d="M87 106Q169 51 244 87Q285 111 313 143Q245 124 211 110Q146 80 87 130Z" fill="#849AB9"/>`;
  } else {
    fringe = `<path d="M47 234Q18 179 45 132L69 111L31 114Q12 110 20 94Q27 83 60 82L108 83L81 72L49 72Q28 64 42 48Q54 38 104 41C144 31 172 43 194 56C302 39 359 142 349 251L318 234L294 177Q215 188 143 116Q90 159 65 238Z" fill="${navy}"/>
      <path d="M178 56Q277 45 319 136Q273 168 226 123Z" fill="#1B3971"/>`;
  }
  const eyes = [140, 265].map(x => `<g transform="translate(${x} 248)"><g class="blink"><g class="expression">
    <rect class="open-eye" x="-11" y="-30" width="22" height="60" rx="11" fill="${navy}"/>
    <path class="happy-eye" d="M-17 4Q0-24 17 4" fill="none" stroke="${navy}" stroke-width="11" stroke-linecap="round"/>
    </g></g></g>`).join('');
  const glasses = boy ? '' : man
    ? `<g fill="none" stroke="${navy}" stroke-width="7"><rect x="85" y="203" width="107" height="90" rx="22"/><rect x="214" y="203" width="107" height="90" rx="22"/><path d="M192 236Q204 231 214 236"/></g>
      <path d="M58 229H84M322 229H342" stroke="${gold}" stroke-width="10" stroke-linecap="round"/>`
    : `<g fill="none" stroke="${old ? navy : gold}" stroke-width="${old ? 4 : 5}">
      <ellipse cx="140" cy="248" rx="46" ry="${old ? 37 : 46}"/><ellipse cx="265" cy="248" rx="46" ry="${old ? 37 : 46}"/>
      <path d="M186 243Q204 229 219 243M94 241L65 234M311 241L337 234"/></g>`;
  const dashes = [0, 1, 2].map(i => `<rect class="signal" x="${man ? 309 : 292 + i * 3}" y="${(man ? 218 : 150) + i * (man ? 12 : 17)}" width="${man ? 20 : 43 - i * 6}" height="${man ? 7 : 10}" rx="5" fill="${gold}" style="animation-delay:${i * 160}ms"/>`).join('');
  return `<svg viewBox="0 0 400 400" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <g class="drag-group"><g class="follow-group"><g class="action-group"><g class="gesture-group"><g transform="translate(0 -6) rotate(12 200 235) scale(.94)">
      ${pony}${back}${face}${fringe}
      <g class="gaze"><g class="thinking-gaze">${eyes}</g></g>
      <g class="glasses">${glasses}</g><g class="brand-marks">${dashes}</g>
    </g></g></g></g></g></svg>`;
}
