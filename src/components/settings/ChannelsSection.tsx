import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

import { type SettingsCopy } from "../../i18n/copy/settings";
import { CHANNEL_FIELDS, type ChannelPatch, type ChannelView } from "../../pi/imChannels/types";
import type { ImChannelsState } from "../../runtime/useImChannels";
import { useBotNames } from "../shell/ShellExtras";
import { Button, Input, SelectMenu, Switch } from "../ui";
import { Dot, Field, MASK, Segmented } from "./SettingsShared";
const CHANNEL_LOGOS = { feishu: "/brand/im/feishu.png", dingtalk: "/brand/im/dingtalk.png", wecom: "/brand/im/wecom.png", telegram: "/brand/im/telegram.svg" } as const;

export function ChannelsSection({ t, state }: { t: SettingsCopy; state: ImChannelsState }) {
  const [expanded, setExpanded] = useState<string | undefined>();
  return (
    <>
      <p className="settings-intro">{t.channels.intro}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="status"><Dot />{t.channels.loadFailed(state.error)}</p> : null}
      <div className="settings-list">
        {(state.channels ?? []).map((channel) => (
          <ChannelRow
            key={channel.platform}
            t={t}
            channel={channel}
            state={state}
            open={expanded === channel.platform}
            onToggleOpen={() => setExpanded((current) => (current === channel.platform ? undefined : channel.platform))}
          />
        ))}
      </div>
      <p className="settings-note">{t.channels.commands}</p>
    </>
  );
}

function ChannelRow({ t, channel, state, open, onToggleOpen }: {
  t: SettingsCopy;
  channel: ChannelView;
  state: ImChannelsState;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const c = t.channels;
  const botNames = useBotNames();
  const name = c.names[channel.platform];
  const [fields, setFields] = useState<Record<string, string>>(channel.fields);
  const [allowText, setAllowText] = useState(channel.allowUsers.join(", "));
  useEffect(() => setAllowText(channel.allowUsers.join(", ")), [channel.allowUsers]);
  const saving = state.saving === channel.platform;
  const saveError = state.saveError?.platform === channel.platform ? state.saveError.message : undefined;
  const complete = CHANNEL_FIELDS[channel.platform].every(({ key, secret }) => fields[key]?.trim() || (secret && channel.secretsSet[key]));
  const tone = { off: "muted", connecting: "warn", connected: "ok", error: "error" }[channel.status.state];
  const allowUsers = (text: string) => text.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean);
  const save = (patch: ChannelPatch) => void state.save(channel.platform, patch);
  const saveAll = () => {
    save({ enabled: true, fields, allowUsers: allowUsers(allowText) });
    setFields((current) => Object.fromEntries(Object.entries(current).map(([key, value]) =>
      [key, CHANNEL_FIELDS[channel.platform].find((field) => field.key === key)?.secret ? "" : value])));
  };

  return (
    <div className="settings-provider" data-open={open}>
      <div className="settings-row">
        <span className="settings-channel-mark" aria-hidden="true">
          <img src={CHANNEL_LOGOS[channel.platform]} alt="" width={28} height={28} />
        </span>
        <button type="button" className="settings-row-main settings-row-button" aria-expanded={open} onClick={onToggleOpen}>
          <span className="settings-row-title"><strong>{name}</strong></span>
          <span className="settings-row-sub settings-row-meta">
            {channel.status.botName ? <span>{channel.status.botName}</span> : null}
            <span>{botNames[channel.botId ?? channel.agentPreset] ?? channel.botId}</span>
            <span>{channel.access === "open" ? c.open : c.allowlist}</span>
          </span>
        </button>
        <span className="settings-key-pill" data-tone={tone}><Dot />{c.state[channel.status.state]}</span>
        <Switch
          size="sm"
          aria-label={`${t.providers.enabled} ${name}`}
          checked={channel.enabled}
          disabled={saving || (!channel.enabled && !complete)}
          title={!channel.enabled && !complete ? c.fillFirst : undefined}
          // Turning on also sends what is typed, so a filled-in form connects without a second click.
          onCheckedChange={(checked) => (checked ? saveAll() : save({ enabled: false }))}
        />
        <button type="button" className="settings-chevron" aria-label={name} aria-expanded={open} onClick={onToggleOpen}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="settings-provider-editor">
          <p className="settings-note">{c.setup[channel.platform]}</p>
          {CHANNEL_FIELDS[channel.platform].map(({ key, secret }) => (
            <Field key={key} label={c.fields[key as keyof typeof c.fields]} hint={secret && channel.secretsSet[key] ? c.secretHint : undefined}>
              <div className="settings-field-row">
                <Input
                  type={secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secret ? (channel.secretsSet[key] ? MASK : c.secretEmpty) : undefined}
                  value={fields[key] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setFields((current) => ({ ...current, [key]: value }));
                  }}
                />
                {secret && channel.secretsSet[key] && !fields[key] ? <span className="settings-status" data-tone="ok"><Dot />{c.secretSaved}</span> : null}
              </div>
            </Field>
          ))}
          <Field label={c.role}>
            <SelectMenu
              ariaLabel={c.role}
              value={channel.botId ?? channel.agentPreset}
              options={Object.entries(botNames).map(([value, label]) => ({ value, label }))}
              onValueChange={(value) => save({ botId: value })}
            />
          </Field>
          <Field label={c.access}>
            <Segmented
              ariaLabel={c.access}
              value={channel.access}
              options={[{ value: "allowlist" as const, label: c.allowlist }, { value: "open" as const, label: c.open }]}
              disabled={saving}
              onChange={(access) => save({ access })}
            />
          </Field>
          {channel.access === "open" ? <span className="settings-status" data-tone="error"><Dot />{c.openWarning}</span> : (
            <Field label={c.allowUsers} hint={c.allowUsersHint}>
              <Input
                spellCheck={false}
                value={allowText}
                onChange={(event) => setAllowText(event.target.value)}
                onBlur={() => {
                  const next = allowUsers(allowText);
                  if (next.join() !== channel.allowUsers.join()) save({ allowUsers: next });
                }}
              />
            </Field>
          )}
          {channel.denied.length > 0 && channel.access === "allowlist" ? (
            <Field label={c.denied}>
              <div className="settings-list">
                {channel.denied.map((entry) => (
                  <div className="settings-row settings-about-row" key={entry.id}>
                    <span className="settings-about-label">{entry.name ?? "—"}</span>
                    <code>{entry.id}</code>
                    <Button size="sm" variant="ghost" disabled={saving} onClick={() => save({ allowUsers: [...channel.allowUsers, entry.id] })}>{c.allow}</Button>
                  </div>
                ))}
              </div>
            </Field>
          ) : null}
          <p className="settings-note">{channel.model ? c.model(channel.model.model) : c.noModel}</p>
          <div className="settings-provider-actions">
            <Button size="sm" disabled={saving || !complete} onClick={saveAll}>
              {saving ? c.saving : channel.enabled && channel.status.state === "error" ? c.reconnect : c.save}
            </Button>
            {saveError ? (
              <span className="settings-status" data-tone="error" role="status"><Dot />{c.saveFailed(saveError)}</span>
            ) : channel.status.error ? (
              <span className="settings-status" data-tone="error" role="status"><Dot />{channel.status.error}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
