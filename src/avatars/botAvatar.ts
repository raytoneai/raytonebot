import { DEFAULT_BOT, parseBotAppearance, type BotAppearance } from '../runtime/botAppearance.ts';
import { material, relief, tint } from './avatarMaterials.ts';
import { isAgentHarnessId, type AgentHarnessId } from '../pi/harnessCatalog.ts';
import { harnessLogo } from './harnessArtwork.ts';
import { providerArtwork } from './providerArtwork.ts';

let serial = 0;
function drawingId(id?: string): string { return (id ?? `bot-${++serial}`).replace(/[^a-zA-Z0-9_-]/g, ''); }
function materials(id: string, b: BotAppearance): string {
  return `<defs>${material(`${id}-face`, b.faceColor)}${material(`${id}-hair`, b.hairColor)}
    ${material(`${id}-eyes`, b.eyeColor)}${material(`${id}-accessory`, b.accessoryColor)}
    ${relief(`${id}-relief`)}
    ${b.accessory === 'cap' || b.accessory === 'beanie' ? `<clipPath id="${id}-under-hat"><path d="M0 34H100V100H0Z"/></clipPath>` : ''}
  </defs>`;
}

function faceShape(face: BotAppearance['face']): string {
  const shapes: Record<BotAppearance['face'], string> = {
    round: '<ellipse cx="50" cy="53" rx="36" ry="36"/>',
    oval: '<ellipse cx="50" cy="53" rx="33" ry="36"/>',
    'soft-square': '<rect x="14" y="17" width="72" height="72" rx="25"/>',
    wide: '<ellipse cx="50" cy="56" rx="39" ry="33"/>',
    heart: '<path d="M50 17C27 14 13 29 15 49C17 65 31 84 50 91C69 84 83 65 85 49C87 29 73 14 50 17Z"/>',
    pear: '<path d="M50 20C30 20 23 34 21 49C20 61 10 66 15 77C22 94 78 94 85 77C90 66 80 61 79 49C77 34 70 20 50 20Z"/>',
    angular: '<path d="M34 18H66Q71 18 75 25L85 45Q88 52 83 64L69 83Q66 89 59 89H41Q34 89 31 83L17 64Q12 53 15 45L25 25Q29 18 34 18Z"/>',
  };
  return shapes[face];
}

/** Shared geometry for the avatar and its face-free option thumbnails. */
function botParts(detailColor: string, id: string, harness?: AgentHarnessId) {
  const hair: Record<BotAppearance['hair'], string> = {
    none: '',
    quiff: '<path d="M17 37Q19 15 47 17Q67 17 75 7Q88 32 63 34Q43 27 17 37Z"/>',
    bob: '<path d="M12 79V42Q10 10 50 10Q90 10 88 42V79Q79 84 76 76V40Q61 42 52 30Q44 42 24 40V77Q20 84 12 79Z"/>',
    pixie: '<path d="M13 42Q13 11 53 12Q82 12 88 43L75 35L77 44Q58 38 55 29Q40 42 20 45L24 35Z"/>',
    buns: '<circle cx="18" cy="23" r="12"/><circle cx="82" cy="23" r="12"/><path d="M14 39Q15 12 50 12Q85 12 86 39Q65 40 50 26Q35 40 14 39Z"/>',
    long: '<path d="M5 83Q12 70 11 43Q10 10 50 10Q90 10 89 43Q88 70 95 83Q83 90 77 78V40Q63 38 59 28Q45 42 23 46V78Q17 90 5 83Z"/>',
    'crew-cut': '<path d="M14 42C14 22 29 13 50 13C71 13 86 22 86 42L80 37C64 31 36 31 20 37Z"/>',
    crop: '<path d="M13 44V34C13 17 28 10 50 10C72 10 87 18 87 36V44L75 39L64 43L52 38L40 43L28 39Z"/>',
    curly: '<path d="M12 43C4 37 8 26 17 24C14 13 27 7 35 14C40 3 55 4 59 12C68 5 81 11 81 21C92 21 97 34 88 42L77 39Q70 45 61 37Q50 46 41 38Q29 45 22 39Z"/>',
    curtains: '<path d="M12 44C10 20 28 8 50 10C72 8 90 20 88 44Q64 42 53 23L50 18L47 23Q36 42 12 44Z"/>',
    ponytail: '<path d="M76 25C102 20 98 53 87 64Q80 72 87 86C69 80 71 61 77 49Q84 34 76 25Z"/><path d="M13 43C11 20 29 9 51 10C74 10 88 24 86 43Q63 38 54 25Q37 42 13 43Z"/>',
    wavy: '<path d="M10 84C-1 74 15 67 10 55C1 39 12 12 38 10C67 0 90 19 88 44C84 59 100 66 92 79Q84 91 75 82C77 67 75 54 74 42Q61 40 54 29Q43 43 25 45C22 58 27 66 24 80Q19 91 10 84Z"/>',
  };
  const accessories: Record<BotAppearance['accessory'], string> = {
    none: '',
    clip: '<rect x="72" y="31" width="5" height="15" rx="2.5" transform="rotate(35 74 38)"/>',
    bow: '<path d="M65 19Q53 5 53 20Q53 31 65 23Q79 33 79 20Q79 6 65 19Z"/><circle cx="65" cy="21" r="3"/>',
    star: '<path d="M77 24L80 31L88 32L82 38L84 46L77 42L70 46L72 38L66 32L74 31Z"/>',
    headphones: `<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M10 54V45C10-2 90-2 90 45V54"/></g><rect x="5" y="43" width="12" height="25" rx="6"/><rect x="83" y="43" width="12" height="25" rx="6"/><g fill="none" stroke="${detailColor}" stroke-width="1.5" opacity=".45"><path d="M11 50V61M89 50V61"/></g>`,
    headset: '<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M10 54V45C10-2 90-2 90 45V54M89 64Q89 78 66 78"/></g><rect x="5" y="43" width="12" height="25" rx="6"/><rect x="83" y="43" width="12" height="25" rx="6"/><rect x="59" y="75" width="11" height="6" rx="3"/>',
    cap: `<path d="M12 37C12-3 86-3 86 34L86 38Q51 32 12 40Z"/><path d="M13 37Q51 30 81 32Q94 32 98 39Q98 43 91 43L68 39Q38 36 13 41Z"/><path d="M49 11Q56 19 56 30M19 36Q49 31 79 34" fill="none" stroke="${detailColor}" stroke-width="1.6" opacity=".35"/><rect x="41" y="18" width="16" height="3" rx="1.5" fill="${detailColor}" opacity=".65"/>`,
    beanie: `<path d="M12 35C12-3 88-3 88 35Z"/><rect x="10" y="29" width="80" height="14" rx="6"/><g fill="none" stroke="${detailColor}" stroke-width="1.5" opacity=".3"><path d="M27 17L24 29M42 10L40 29M58 10L60 29M73 17L76 29M18 34V39M29 34V39M40 34V39M51 34V39M62 34V39M73 34V39M84 34V39"/></g>`,
    glasses: '<g fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="36" cy="56" r="12"/><circle cx="64" cy="56" r="12"/><path d="M48 55H52M16 53L24 54M76 54L84 53"/></g>',
    scarf: `<path d="M63 82L78 85L74 98L58 96Z"/><path d="M22 77Q50 88 78 77L80 85Q50 98 20 85Z"/><g fill="none" stroke="${detailColor}" stroke-width="1.3" opacity=".42"><path d="M25 81Q49 91 75 81M62 94L73 96M64 89L75 91"/></g>`,
    neckerchief: `<path d="M21 77Q50 89 79 77L68 86L50 98L32 86Z"/><path d="M23 78Q50 88 77 78L71 84Q50 93 29 84Z"/><path d="M36 88L50 94L64 88" fill="none" stroke="${detailColor}" stroke-width="1.2" opacity=".45"/>`,
    bowtie: `<path d="M47 86C37 78 27 77 27 88C27 99 38 97 47 91L53 91C62 97 73 99 73 88C73 77 63 78 53 86Z"/><g fill="none" stroke="${detailColor}" stroke-width="1.2" opacity=".4"><path d="M34 85L46 88L34 92M66 85L54 88L66 92"/></g><rect x="46" y="83" width="8" height="11" rx="3"/>`,
    flower: `<g><circle cx="76" cy="20" r="6"/><circle cx="84" cy="25" r="6"/><circle cx="81" cy="34" r="6"/><circle cx="71" cy="34" r="6"/><circle cx="68" cy="25" r="6"/><circle cx="76" cy="27" r="5" fill="#FDE7B4"/><circle cx="75" cy="26" r="1.5" fill="#fff4dd"/></g>`,
    sunglasses: `<path d="M14 46L24 49M76 49L86 46" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>
      <rect x="17" y="42" width="31" height="27" rx="9"/><rect x="52" y="42" width="31" height="27" rx="9"/>
      <path d="M46 50Q50 47 54 50" fill="none" stroke="currentColor" stroke-width="4"/>
      <g fill="#101D36"><rect x="20" y="45" width="25" height="21" rx="6"/><rect x="55" y="45" width="25" height="21" rx="6"/></g>
      <g fill="none" stroke="#DCE7F4" stroke-linecap="round"><path d="M24 50L34 48M25 54L39 50M58 49L62 48" stroke-width="2" opacity=".38"/></g>
      ${isAgentHarnessId(harness) ? `<defs><clipPath id="${id}-lens"><rect x="55" y="45" width="25" height="21" rx="6"/></clipPath></defs>
        <g data-harness="${harness}" clip-path="url(#${id}-lens)">${harnessLogo(harness, 'lens')}
          <path d="M58 48L66 46" stroke="#E6EEF7" stroke-width="1.1" opacity=".2" fill="none"/>
        </g>` : ''}`,
  };
  return { hair, accessories };
}

/** Preserve the existing gaze, blink, drag and state poses with shaded materials. */
export function botAvatarSVG(value: BotAppearance, options: { id?: string; harness?: AgentHarnessId } = {}): string {
  const saved = parseBotAppearance(value) ?? DEFAULT_BOT;
  const id = drawingId(options.id);
  const mascot = saved.mascot ? providerArtwork(saved.mascot, id) : undefined;
  const b = mascot ? { ...saved, faceColor: mascot.faceColor, eyeColor: mascot.eyeColor, hair: 'none' as const, accessory: 'none' as const } : saved;
  const { hair, accessories } = botParts(b.faceColor, id, options.harness);
  const visibleHair = b.hair === 'quiff' && (b.accessory === 'cap' || b.accessory === 'beanie') ? '' : hair[b.hair];
  const head = mascot?.head ?? faceShape(b.face);
  const hairClip = b.accessory === 'cap' || b.accessory === 'beanie' ? ` clip-path="url(#${id}-under-hat)"` : '';
  const eyes = [36, 64].map(x => `<g transform="translate(${x} 56)"><g class="blink"><g class="expression">
    <rect class="open-eye" x="-3.6" y="-9.5" width="7.2" height="19" rx="3.6"/>
    <path class="happy-eye" d="M-5 1Q0-7 5 1" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>
  </g></g></g>`).join('');
  const accessory = accessories[b.accessory].replaceAll('stroke="currentColor"', `stroke="url(#${id}-accessory)"`);
  // Keep fins and star points inside the frame throughout the existing head turns.
  return `<svg viewBox="${b.mascot ? '-40 -40 480 480' : '0 0 400 400'}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"${b.mascot ? ` data-mascot="${b.mascot}"` : ''}>${materials(id, b)}
    <g class="drag-group"><g class="follow-group"><g class="action-group"><g class="gesture-group"><g class="breath">
    <g transform="scale(4)">
      ${mascot?.back ?? ''}
      <g transform="translate(0 1.6)" fill="${tint(b.faceColor, -.24)}">${head}</g>
      <g fill="${b.faceColor}"><g fill="${mascot?.faceFill ?? `url(#${id}-face)`}" stroke="${tint(b.faceColor, .23)}" stroke-width=".4">${head}</g></g>
      <g${hairClip}>
        <g transform="translate(0 1.5)" fill="${tint(b.hairColor, -.32)}">${visibleHair}</g>
        <g fill="${b.hairColor}"><g fill="url(#${id}-hair)" filter="url(#${id}-relief)">${visibleHair}</g></g>
      </g>
    </g>
    <g class="gaze"><g class="thinking-gaze"><g transform="scale(4)" fill="url(#${id}-eyes)" color="${b.eyeColor}">${eyes}</g></g></g>
    <g transform="scale(4)" fill="${b.accessoryColor}" color="${b.accessoryColor}"><g fill="url(#${id}-accessory)" filter="url(#${id}-relief)">${accessory}</g>${mascot?.front ?? ''}</g>
  </g></g></g></g></g></svg>`;
}

/** Crops contain only the selected piece and use the same shaded material as the live avatar. */
const PART_CROPS = {
  hair: { none: "0 0 100 100", quiff: "10 0 80 44", bob: "4 4 92 84", pixie: "8 7 84 43", buns: "0 4 100 44", long: "0 4 100 88", 'crew-cut': "8 8 84 42", crop: "7 4 86 48", curly: "2 0 96 52", curtains: "6 4 88 48", ponytail: "6 4 94 88", wavy: "0 2 100 92" },
  accessory: { none: "0 0 100 100", clip: "65 26 20 24", bow: "47 5 38 32", star: "62 20 30 30", glasses: "10 36 80 38", headphones: "-1 4 102 74", headset: "-1 4 102 84", cap: "5 0 98 50", beanie: "4 0 92 50", scarf: "15 72 70 30", neckerchief: "16 72 68 30", bowtie: "22 74 56 28", flower: "58 10 38 36", sunglasses: "9 36 82 40" },
} as const;

export function botPartSVG(part: 'face' | 'hair' | 'accessory', value: BotAppearance, id?: string, harness?: AgentHarnessId): string {
  const b = parseBotAppearance(value) ?? DEFAULT_BOT;
  const prefix = drawingId(id);
  const { hair, accessories } = botParts(b.faceColor, prefix, harness);
  const crop = part === 'face' ? '6 12 88 84' : part === 'hair' ? PART_CROPS.hair[b.hair] : PART_CROPS.accessory[b.accessory];
  let shape = part === 'face' ? faceShape(b.face) : part === 'hair' ? hair[b.hair] : accessories[b.accessory];
  if (!shape) return `<svg viewBox="${crop}" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>`;
  const color = part === 'face' ? b.faceColor : part === 'hair' ? b.hairColor : b.accessoryColor;
  shape = shape.replaceAll('stroke="currentColor"', `stroke="url(#${prefix}-part)"`);
  return `<svg viewBox="${crop}" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>${material(`${prefix}-part`, color)}${relief(`${prefix}-relief`)}</defs>
    <g fill="url(#${prefix}-part)" color="${color}" filter="url(#${prefix}-relief)">${shape}</g>
  </svg>`;
}
