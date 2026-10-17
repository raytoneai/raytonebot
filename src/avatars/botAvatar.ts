import { DEFAULT_BOT, parseBotAppearance, type BotAppearance } from '../runtime/botAppearance.ts';

/** Same motion layers as the existing personas: gaze, blink, drag and state poses. */
export function botAvatarSVG(value: BotAppearance): string {
  const b = parseBotAppearance(value) ?? DEFAULT_BOT;
  const hair: Record<BotAppearance['hair'], string> = {
    none: '',
    quiff: '<path d="M17 37Q19 15 47 17Q67 17 75 7Q88 32 63 34Q43 27 17 37Z"/>',
    bob: '<path d="M12 79V42Q10 10 50 10Q90 10 88 42V79Q79 84 76 76V40Q61 42 52 30Q44 42 24 40V77Q20 84 12 79Z"/>',
    pixie: '<path d="M13 42Q13 11 53 12Q82 12 88 43L75 35L77 44Q58 38 55 29Q40 42 20 45L24 35Z"/>',
    buns: '<circle cx="18" cy="23" r="12"/><circle cx="82" cy="23" r="12"/><path d="M14 39Q15 12 50 12Q85 12 86 39Q65 40 50 26Q35 40 14 39Z"/>',
    long: '<path d="M5 83Q12 70 11 43Q10 10 50 10Q90 10 89 43Q88 70 95 83Q83 90 77 78V40Q63 38 59 28Q45 42 23 46V78Q17 90 5 83Z"/>',
  };
  const accessories: Record<BotAppearance['accessory'], string> = {
    none: '',
    clip: '<rect x="72" y="31" width="5" height="15" rx="2.5" transform="rotate(35 74 38)"/>',
    bow: '<path d="M65 19Q53 5 53 20Q53 31 65 23Q79 33 79 20Q79 6 65 19Z"/><circle cx="65" cy="21" r="3"/>',
    star: '<path d="M77 24L80 31L88 32L82 38L84 46L77 42L70 46L72 38L66 32L74 31Z"/>',
    headphones: `<g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M10 54V45C10-2 90-2 90 45V54"/></g><rect x="5" y="43" width="12" height="25" rx="6"/><rect x="83" y="43" width="12" height="25" rx="6"/><g fill="none" stroke="${b.faceColor}" stroke-width="1.5" opacity=".45"><path d="M11 50V61M89 50V61"/></g>`,
    headset: '<g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M10 54V45C10-2 90-2 90 45V54M89 64Q89 78 66 78"/></g><rect x="5" y="43" width="12" height="25" rx="6"/><rect x="83" y="43" width="12" height="25" rx="6"/><rect x="59" y="75" width="11" height="6" rx="3"/>',
    cap: `<path d="M12 37C12-3 86-3 86 34L86 38Q51 32 12 40Z"/><path d="M13 37Q51 30 81 32Q94 32 98 39Q98 43 91 43L68 39Q38 36 13 41Z"/><path d="M49 11Q56 19 56 30M19 36Q49 31 79 34" fill="none" stroke="${b.faceColor}" stroke-width="1.6" opacity=".35"/><rect x="41" y="18" width="16" height="3" rx="1.5" fill="${b.faceColor}" opacity=".65"/>`,
    beanie: `<path d="M12 35C12-3 88-3 88 35Z"/><rect x="10" y="29" width="80" height="14" rx="6"/><g fill="none" stroke="${b.faceColor}" stroke-width="1.5" opacity=".3"><path d="M27 17L24 29M42 10L40 29M58 10L60 29M73 17L76 29M18 34V39M29 34V39M40 34V39M51 34V39M62 34V39M73 34V39M84 34V39"/></g>`,
    glasses: '<g fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="36" cy="56" r="12"/><circle cx="64" cy="56" r="12"/><path d="M48 55H52M16 53L24 54M76 54L84 53"/></g>',
  };
  const visibleHair = b.hair === 'quiff' && (b.accessory === 'cap' || b.accessory === 'beanie') ? '' : hair[b.hair];
  const head = b.face === 'soft-square' ? '<rect x="14" y="17" width="72" height="72" rx="25"/>'
    : `<ellipse cx="50" cy="53" rx="${b.face === 'oval' ? 33 : 36}" ry="36"/>`;
  const eyes = [36, 64].map(x => `<g transform="translate(${x} 56)"><g class="blink"><g class="expression">
    ${b.eyes === 'round' ? '<circle class="open-eye" r="5.4"/>' : b.eyes === 'smile' ? '<path class="open-eye" d="M-5 1Q0-7 5 1" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>' : '<rect class="open-eye" x="-3.6" y="-9.5" width="7.2" height="19" rx="3.6"/>'}
    <path class="happy-eye" d="M-5 1Q0-7 5 1" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>
  </g></g></g>`).join('');
  return `<svg viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g class="drag-group"><g class="follow-group"><g class="action-group"><g class="gesture-group"><g class="breath">
    <g transform="scale(4)"><g fill="${b.faceColor}">${head}</g><g fill="${b.hairColor}">${visibleHair}</g></g>
    <g class="gaze"><g class="thinking-gaze"><g transform="scale(4)" fill="${b.eyeColor}" color="${b.eyeColor}">${eyes}</g></g></g>
    <g transform="scale(4)" fill="${b.accessoryColor}" color="${b.accessoryColor}">${accessories[b.accessory]}</g>
  </g></g></g></g></g></svg>`;
}
