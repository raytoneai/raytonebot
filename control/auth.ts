import type { IncomingMessage } from "node:http";

/**
 * Who is asking (ADR-041). The prototype has no login: CONTROL_DEV_USER names the one user, and the
 * server refuses to listen beyond loopback in that mode. Connecting the real Raytone login means
 * replacing only this function, e.g. verifying its session cookie and returning the account id.
 */
export type User = { id: string };

export function currentUser(_req: IncomingMessage): User | undefined {
  const id = process.env.CONTROL_DEV_USER;
  return id ? { id } : undefined;
}

export const devLoginActive = () => Boolean(process.env.CONTROL_DEV_USER);
