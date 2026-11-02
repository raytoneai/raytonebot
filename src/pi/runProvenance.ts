import type { ControlAuthorization } from "./controlPlaneAuth.ts";
import type { PiPermissionMode } from "./approvalGate.ts";
import { CHANNEL_PLATFORMS, type ChannelPlatform } from "./imChannels/types.ts";

export type RunOrigin = { kind: "web" } | { kind: "im"; platform: ChannelPlatform; requesterId: string }
  | { kind: "routine"; routineId: string; occurrenceId: string };
export type RunParent = { conversationId: string; runId: string; taskId?: string };
export type RunProvenance = {
  origin: RunOrigin;
  authorization?: ControlAuthorization;
  permissionMode: PiPermissionMode;
  requestedPermissionMode?: PiPermissionMode;
  readOnly?: boolean;
  parent?: RunParent;
};
/** Trusted host context only. Never accept this object from model/tool arguments or prompt JSON. */
export type RunSourceOptions = { origin?: RunOrigin; authorization?: ControlAuthorization; parent?: RunParent; requestedPermissionMode?: PiPermissionMode };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 320 && !/[\u0000-\u0020\u007f]/.test(value);
const mode = (value: unknown): value is PiPermissionMode => value === "request" || value === "auto" || value === "allow-all";
export function validRunProvenance(value: unknown): value is RunProvenance {
  if (!record(value) || !keys(value, ["origin", "authorization", "permissionMode", "requestedPermissionMode", "readOnly", "parent"]) || !mode(value.permissionMode)) return false;
  if (value.authorization !== undefined) {
    const auth = value.authorization;
    if (!record(auth) || !keys(auth, ["requestedBy", "authorizedVia", "scope", "version", "at"]) || auth.requestedBy !== "user_session" || !identifier(auth.authorizedVia) || !["user", "developer"].includes(auth.scope as string) || auth.version !== 1 || !Number.isSafeInteger(auth.at) || (auth.at as number) < 0) return false;
  }
  if (value.requestedPermissionMode !== undefined && (!mode(value.requestedPermissionMode) || value.requestedPermissionMode === value.permissionMode)) return false;
  if (value.readOnly !== undefined && typeof value.readOnly !== "boolean") return false;
  const origin = value.origin;
  if (!record(origin)) return false;
  if (origin.kind === "web") { if (!keys(origin, ["kind"])) return false; }
  else if (origin.kind === "im") {
    if (!keys(origin, ["kind", "platform", "requesterId"]) || !CHANNEL_PLATFORMS.includes(origin.platform as ChannelPlatform) || !identifier(origin.requesterId)) return false;
  } else if (origin.kind === "routine") {
    if (!keys(origin, ["kind", "routineId", "occurrenceId"]) || !identifier(origin.routineId) || !identifier(origin.occurrenceId)) return false;
  } else return false;
  const parent = value.parent;
  return parent === undefined || record(parent) && keys(parent, ["conversationId", "runId", "taskId"])
    && identifier(parent.conversationId) && identifier(parent.runId) && (parent.taskId === undefined || identifier(parent.taskId));
}

export function runProvenance(source: RunSourceOptions | undefined, permissionMode: PiPermissionMode, readOnly = false): RunProvenance | undefined {
  // Legacy/internal callers without a known entrypoint must not be attributed to a browser user.
  if (!source?.origin) return;
  const value = { origin: source.origin, ...(source.authorization ? { authorization: source.authorization } : {}), permissionMode, ...(source.requestedPermissionMode && source.requestedPermissionMode !== permissionMode
    ? { requestedPermissionMode: source.requestedPermissionMode } : {}), ...(readOnly ? { readOnly: true } : {}), ...(source.parent ? { parent: source.parent } : {}) };
  if (!validRunProvenance(value)) throw new Error("Invalid host run provenance.");
  return structuredClone(value);
}
