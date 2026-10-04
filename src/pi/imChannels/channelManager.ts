import { join } from "node:path";

import type { PiPermissionMode } from "../approvalGate.ts";
import type { runtimeLogger } from "../hostOperations.ts";
import { ChannelBridge, errorMessage, type ChannelRuntime } from "./channelBridge.ts";
import { ChannelStore, type ChannelSettings } from "./channelStore.ts";
import type { ChannelConnector, ConnectorInput } from "./connectors/connector.ts";
import { CHANNEL_FIELDS, CHANNEL_PLATFORMS, type ChannelPatch, type ChannelPlatform, type ChannelView } from "./types.ts";

export type ConnectorFactories = Record<ChannelPlatform, (input: ConnectorInput) => ChannelConnector>;

const defaultFactories = async (): Promise<ConnectorFactories> => {
  const [{ feishuConnector }, { dingtalkConnector }, { wecomConnector }, { telegramConnector }] = await Promise.all([
    import("./connectors/feishu.ts"), import("./connectors/dingtalk.ts"), import("./connectors/wecom.ts"), import("./connectors/telegram.ts"),
  ]);
  return { feishu: feishuConnector, dingtalk: dingtalkConnector, wecom: wecomConnector, telegram: (input) => telegramConnector(input) };
};

export type ChannelManager = {
  list(): ChannelView[];
  update(platform: ChannelPlatform, patch: ChannelPatch): ChannelView[];
  dispose(): void;
};

/** Keeps each enabled channel connected and its status readable by the settings page. */
export function createChannelManager(options: {
  runtime: ChannelRuntime;
  dataDir: string;
  defaultPermissionMode: PiPermissionMode;
  factories?: ConnectorFactories;
  log?: ReturnType<typeof runtimeLogger>;
}): ChannelManager {
  const store = new ChannelStore(join(options.dataDir, "im-channels.json"));
  const factories = options.factories ? Promise.resolve(options.factories) : defaultFactories();
  type Slot = { connector?: ChannelConnector; generation: number; status: ChannelView["status"]; denied: ChannelView["denied"] };
  const slots = Object.fromEntries(CHANNEL_PLATFORMS.map((platform) => [platform, { generation: 0, status: { state: "off" }, denied: [] } as Slot])) as Record<ChannelPlatform, Slot>;
  const bridges = Object.fromEntries(CHANNEL_PLATFORMS.map((platform) => [platform, new ChannelBridge({
    platform,
    runtime: options.runtime,
    store,
    settings: () => store.get(platform),
    defaultPermissionMode: options.defaultPermissionMode,
    log: options.log,
    onDenied(sender) {
      const slot = slots[platform];
      slot.denied = [{ ...sender, at: Date.now() }, ...slot.denied.filter((entry) => entry.id !== sender.id)].slice(0, 10);
    },
  })])) as Record<ChannelPlatform, ChannelBridge>;

  const restart = (platform: ChannelPlatform) => {
    const slot = slots[platform];
    const generation = ++slot.generation;
    void Promise.resolve(slot.connector?.stop()).catch(() => undefined);
    slot.connector = undefined;
    const settings = store.get(platform);
    if (!settings.enabled) {
      slot.status = { state: "off" };
      return;
    }
    slot.status = { state: "connecting", since: Date.now() };
    const current = () => slot.generation === generation;
    void factories.then(async (factory) => {
      if (!current()) return;
      const connector = factory[platform]({
        credentials: settings.credentials,
        store,
        onMessage: (message) => {
          if (current()) void bridges[platform].handle(message).catch(() => options.log?.("channel.message_failed", { platform }));
        },
        onState: (state, error) => {
          if (current()) slot.status = { ...slot.status, state, error, since: Date.now() };
        },
      });
      slot.connector = connector;
      const { botName } = await connector.start();
      if (!current()) return void connector.stop();
      slot.status = { state: "connected", botName, since: Date.now() };
      options.log?.("channel.connected", { platform });
    }).catch((error) => {
      if (!current()) return;
      void Promise.resolve(slot.connector?.stop()).catch(() => undefined);
      slot.connector = undefined;
      slot.status = { state: "error", error: errorMessage(error), since: Date.now() };
      options.log?.("channel.connect_failed", { platform });
    });
  };

  const view = (platform: ChannelPlatform): ChannelView => {
    const settings: ChannelSettings = store.get(platform);
    const fields: Record<string, string> = {};
    const secretsSet: Record<string, boolean> = {};
    for (const { key, secret } of CHANNEL_FIELDS[platform]) {
      fields[key] = secret ? "" : settings.credentials[key] ?? "";
      if (secret) secretsSet[key] = Boolean(settings.credentials[key]);
    }
    return {
      platform,
      enabled: settings.enabled,
      fields,
      secretsSet,
      access: settings.access,
      allowUsers: settings.allowUsers,
      agentPreset: settings.agentPreset,
      ...(settings.model ? { model: { provider: settings.model.definition.id, model: settings.model.model } } : {}),
      status: slots[platform].status,
      denied: slots[platform].denied.filter((entry) => !settings.allowUsers.includes(entry.id)),
    };
  };

  for (const platform of CHANNEL_PLATFORMS) if (store.get(platform).enabled) restart(platform);

  return {
    list: () => CHANNEL_PLATFORMS.map(view),
    update(platform, patch) {
      const before = store.get(platform);
      const after = store.update(platform, patch);
      // Access, role and model are read per message; only the connection itself needs a restart.
      if (before.enabled !== after.enabled || JSON.stringify(before.credentials) !== JSON.stringify(after.credentials)
        || (after.enabled && slots[platform].status.state === "error" && patch.enabled === true)) restart(platform);
      return CHANNEL_PLATFORMS.map(view);
    },
    dispose() {
      for (const slot of Object.values(slots)) {
        slot.generation++;
        void Promise.resolve(slot.connector?.stop()).catch(() => undefined);
        slot.connector = undefined;
      }
    },
  };
}
