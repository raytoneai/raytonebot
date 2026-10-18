/** Only typed options and hex colours enter SVG markup; never store arbitrary SVG. */
export const BOT_OPTIONS = {
  face: ['round', 'oval', 'soft-square'],
  eyes: ['capsule', 'round', 'smile'],
  hair: ['none', 'quiff', 'bob', 'pixie', 'buns', 'long'],
  accessory: ['none', 'clip', 'bow', 'star', 'glasses', 'headphones', 'headset', 'cap', 'beanie'],
} as const;
export type BotAppearance = { [K in keyof typeof BOT_OPTIONS]: (typeof BOT_OPTIONS)[K][number] } & {
  faceColor: string; eyeColor: string; hairColor: string; accessoryColor: string;
};
export type BotKind = 'woman' | 'man' | 'boy';
/** Shared face sampled from Rae's saved appearance; role colours belong to accessories. */
export const BOT_PALETTE = {
  face: '#FDE7B4', ink: '#0C2458', raytoneGold: '#E7AC26', claudeOrange: '#D97757', codexBlue: '#4779E6',
} as const;
const sharedFace = { faceColor: BOT_PALETTE.face, eyeColor: BOT_PALETTE.ink, eyes: 'capsule' } as const;
export const DEFAULT_BOTS: Readonly<Record<BotKind, BotAppearance>> = {
  woman: { ...sharedFace, face: 'round', hair: 'long', accessory: 'headset',
    hairColor: BOT_PALETTE.ink, accessoryColor: BOT_PALETTE.raytoneGold },
  man: { ...sharedFace, face: 'soft-square', hair: 'quiff', accessory: 'glasses',
    hairColor: BOT_PALETTE.claudeOrange, accessoryColor: BOT_PALETTE.claudeOrange },
  boy: { ...sharedFace, face: 'round', hair: 'none', accessory: 'cap',
    hairColor: BOT_PALETTE.ink, accessoryColor: BOT_PALETTE.codexBlue },
};
/** Safe fallback for invalid standalone custom SVG input. */
export const DEFAULT_BOT = DEFAULT_BOTS.woman;
export type BotAppearances = Partial<Record<BotKind, BotAppearance>>;
export const BOT_STORAGE_KEY = 'raytone.bot-appearances.v1';
export function parseBotAppearance(value: unknown): BotAppearance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(BOT_OPTIONS) as (keyof typeof BOT_OPTIONS)[]) {
    if (!(BOT_OPTIONS[key] as readonly unknown[]).includes(data[key])) return undefined;
  }
  for (const key of ['faceColor', 'eyeColor', 'hairColor', 'accessoryColor']) {
    if (typeof data[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(data[key] as string)) return undefined;
  }
  return Object.fromEntries([...Object.keys(BOT_OPTIONS), 'faceColor', 'eyeColor', 'hairColor', 'accessoryColor'].map(key => [key, data[key]])) as BotAppearance;
}
export function parseBotAppearances(raw: string | null): BotAppearances {
  try {
    const data = JSON.parse(raw ?? '{}');
    const result: BotAppearances = {};
    for (const kind of ['woman', 'man', 'boy'] as const) {
      const appearance = parseBotAppearance(data?.[kind]);
      if (appearance) result[kind] = appearance;
    }
    return result;
  } catch { return {}; }
}
