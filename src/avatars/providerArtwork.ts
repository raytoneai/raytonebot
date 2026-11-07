import type { ProviderMascot } from '../runtime/botAppearance.ts';

/** Original Bot silhouettes inspired by provider marks; eyes and motion belong to botAvatarSVG. */
export function providerArtwork(mascot: ProviderMascot, id: string) {
  const artwork: Record<ProviderMascot, { faceColor: string; eyeColor: string; head: string; back: string; front: string; faceFill?: string }> = {
    chatgpt: {
      faceColor: '#FFFFFF', eyeColor: '#111111',
      head: '<path d="M50 15C61 9 74 16 78 27C91 30 96 44 89 55C94 69 83 82 70 82C62 94 45 96 35 86C20 89 9 76 13 62C3 51 9 35 21 31C23 18 38 10 50 15Z"/>',
      back: '',
      front: '<g class="mascot-signal" fill="none" stroke="#111111" stroke-width="3.5" stroke-linecap="round"><path d="M29 29Q41 20 52 28L66 37M65 24Q78 32 74 43M82 54Q84 68 72 73M59 83Q45 88 35 78M22 71Q13 60 21 49M17 39Q20 29 29 29"/></g>',
    },
    claude: {
      faceColor: '#D97757', eyeColor: '#141413',
      head: '<rect x="20" y="27" width="60" height="51" rx="12"/>',
      back: '<g fill="#B85A3D"><g class="mascot-limb"><path d="M24 48H15V40H8V59H24Z"/><rect x="28" y="70" width="8" height="18" rx="4"/><rect x="41" y="72" width="7" height="15" rx="3.5"/></g><g class="mascot-limb mascot-limb-right"><path d="M76 48H85V40H92V59H76Z"/><rect x="64" y="70" width="8" height="18" rx="4"/><rect x="52" y="72" width="7" height="15" rx="3.5"/></g></g>',
      front: '<g class="mascot-signal" fill="none" stroke="#FAF9F5" stroke-width="2.6" stroke-linecap="round"><path d="M50 33V42M45.5 37.5H54.5M46.8 34.3L53.2 40.7M46.8 40.7L53.2 34.3"/></g>',
    },
    deepseek: {
      faceColor: '#4D6BFE', eyeColor: '#FFFFFF',
      head: '<path d="M14 54C14 36 28 26 47 26C68 26 82 39 82 59C82 77 66 86 46 86C27 86 14 75 14 54Z"/>',
      back: '<g fill="#415BDA"><g class="mascot-limb mascot-limb-right"><path d="M72 60Q89 53 84 38Q72 32 78 18Q88 22 90 29Q92 20 99 19Q101 34 91 39Q98 61 78 72Z"/></g><g class="mascot-limb"><path d="M24 63Q8 62 6 78Q18 80 29 71Z"/></g></g>',
      front: '<path d="M25 73Q48 85 70 73Q65 85 46 85Q32 85 25 73Z" fill="#DDE4FF"/><g class="mascot-signal" fill="#9CADFF"><path d="M46 23C39 18 39 10 44 7C48 13 49 18 46 23Z"/><path d="M51 22C50 15 55 10 61 12C61 18 57 22 51 22Z"/></g>',
    },
    grok: {
      faceColor: '#111111', eyeColor: '#FFFFFF',
      head: '<circle cx="50" cy="53" r="33"/>',
      back: '<path d="M16 65C-5 79 18 94 57 75C97 55 104 20 82 27" fill="none" stroke="#A3A3A3" stroke-width="4" stroke-linecap="round"/>',
      front: '<path d="M16 65C0 77 19 87 55 71C77 61 91 44 92 34" fill="none" stroke="#F5F5F5" stroke-width="4" stroke-linecap="round"/><g class="mascot-signal" fill="#FFFFFF"><path d="M57 34L73 19L65 36L53 43Z"/></g>',
    },
    gemini: {
      faceColor: '#3186FF', eyeColor: '#102952', faceFill: `url(#${id}-gemini-colour)`,
      head: '<path d="M50 7C56 31 68 43 92 50C70 57 58 70 50 94C42 70 30 57 8 50C32 43 44 31 50 7Z"/>',
      back: `<defs>
        <linearGradient id="${id}-gemini-base" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#F94645"/><stop offset=".43" stop-color="#3186FF"/><stop offset=".62" stop-color="#3186FF"/><stop offset="1" stop-color="#10B866"/></linearGradient>
        <radialGradient id="${id}-gemini-yellow" cx="0" cy=".5" r=".65"><stop stop-color="#F9BF15"/><stop offset=".32" stop-color="#F9BF15" stop-opacity=".95"/><stop offset="1" stop-color="#F9BF15" stop-opacity="0"/></radialGradient>
        <pattern id="${id}-gemini-colour" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#${id}-gemini-base)"/><rect width="100" height="100" fill="url(#${id}-gemini-yellow)"/></pattern>
      </defs>`,
      front: '<g class="mascot-signal" fill="#3186FF"><path d="M80 9Q82 19 91 21Q82 23 80 33Q78 23 69 21Q78 19 80 9Z"/></g>',
    },
    qwen: {
      faceColor: '#082DFF', eyeColor: '#FFFFFF',
      head: '<path d="M30 31C27 11 50 5 61 18C72 11 90 20 86 35C101 45 95 67 81 70C79 89 54 97 42 85C23 92 7 76 14 60C1 45 12 27 30 31Z"/>',
      back: '',
      front: '<g class="mascot-signal" fill="none" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M36 28Q42 20 49 26L57 35L67 27Q74 23 78 30M27 39Q18 43 23 50M75 72Q64 83 54 78"/></g>',
    },
  };
  return artwork[mascot];
}
