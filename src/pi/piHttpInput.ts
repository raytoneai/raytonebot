import type { PiApprovalDecision } from "../harness/adapters/piAdapter.ts";
import type { BrowserInput } from "./browser/browserProtocol.ts";
import { type PiPermissionMode } from "./approvalGate.ts";
import { isAgentPresetId } from "./harnessCatalog.ts";
import { type ChannelPatch } from "./imChannels/types.ts";
import { normalizeModelOptions } from "./modelMetadata.ts";
import type { PiProviderDefinition } from "./piClient.ts";
import { asRecord } from "./piHostUtils.ts";

/** Copies accepted top-level fields; nested field names remain unrestricted. */
export function channelPatch(body: Record<string, unknown>): ChannelPatch {
  const fields = asRecord(body.fields);
  const definition = asRecord(asRecord(body.model).definition);
  const model = stringField(asRecord(body.model), "model");
  return {
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    fields: Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 4096)),
    ...(body.access === "open" || body.access === "allowlist" ? { access: body.access } : {}),
    ...(Array.isArray(body.allowUsers) ? { allowUsers: body.allowUsers.filter((id): id is string => typeof id === "string" && id.length <= 200) } : {}),
    ...(isAgentPresetId(body.agentPreset) ? { agentPreset: body.agentPreset } : {}),
    ...(typeof body.botId === "string" ? { botId: body.botId } : {}),
    ...(model && typeof definition.id === "string" && typeof definition.baseUrl === "string" && Array.isArray(definition.models)
      ? { model: { model, definition: {
        id: definition.id, name: stringField(definition, "name") ?? definition.id, baseUrl: definition.baseUrl,
        protocol: definition.protocol as PiProviderDefinition["protocol"], models: definition.models.filter((entry): entry is string => typeof entry === "string"),
        authMode: definition.authMode === "none" ? "none" : "required",
        ...(definition.modelOptions === undefined ? {} : { modelOptions: normalizeModelOptions(definition.modelOptions, definition.models as string[]) }),
        ...(stringField(definition, "apiKeyEnvVar") ? { apiKeyEnvVar: stringField(definition, "apiKeyEnvVar") } : {}),
      } } } : {}),
  };
}

/** Projects mouse, key or text input; invalid required values return undefined. */
export function browserInput(value: unknown): BrowserInput | undefined {
  const input = asRecord(value);
  const number = (key: string) => typeof input[key] === "number" && Number.isFinite(input[key]) ? input[key] as number : undefined;
  if (input.kind === "mouse" && ["move", "down", "up", "wheel"].includes(String(input.type))) {
    const x = number("x"), y = number("y");
    if (x === undefined || y === undefined || x < 0 || y < 0 || x > 4000 || y > 4000) return undefined;
    const button = ["left", "right", "middle"].includes(String(input.button)) ? input.button as "left" | "right" | "middle" : undefined;
    return { kind: "mouse", type: input.type as "move", x, y, ...(button ? { button } : {}),
      ...(number("deltaX") !== undefined ? { deltaX: Math.max(-5000, Math.min(5000, number("deltaX")!)) } : {}),
      ...(number("deltaY") !== undefined ? { deltaY: Math.max(-5000, Math.min(5000, number("deltaY")!)) } : {}) };
  }
  if (input.kind === "key" && (input.type === "down" || input.type === "up") && typeof input.key === "string" && input.key.length <= 20) return { kind: "key", type: input.type, key: input.key };
  if (input.kind === "text" && typeof input.text === "string" && input.text.length <= 2000) return { kind: "text", text: input.text };
  return undefined;
}

export function permissionMode(value: unknown): PiPermissionMode {
  return value === "auto" || value === "allow-all" ? value : "request";
}

export function approvalDecision(value: unknown): PiApprovalDecision | undefined {
  return value === "yes" || value === "always" || value === "no" ? value : undefined;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] as string : undefined;
}
