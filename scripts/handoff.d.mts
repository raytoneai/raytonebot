export const HANDOFF_PATH: '/__raytone/handoff';
export const SESSION_COOKIE: '__Host-rtb_session';
export const HANDOFF_TTL_MS: 60_000;
export const SESSION_TTL_MS: 604_800_000;

export function assertHandoffSecret(secret: unknown): asserts secret is string;
export const newHandoffSecret: () => string;
export function issueHandoff(secret: string, origin: string, now?: number): string;
export function handoffRedeemer(secret: string, origin: string): (token: unknown, now?: number) => boolean;
export const issueSession: (secret: string, now?: number) => string;
export const sessionValid: (secret: string, token: unknown, now?: number) => boolean;
export function readCookie(header: unknown, name: string): string | undefined;
