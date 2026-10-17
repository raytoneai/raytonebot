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
export const DEFAULT_BOT: BotAppearance = {
  face: 'round', eyes: 'capsule', hair: 'quiff', accessory: 'none',
  faceColor: '#172B46', eyeColor: '#E7AC26', hairColor: '#71869B', accessoryColor: '#E7AC26',
};
export type BotKind = 'woman' | 'man' | 'boy';
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
