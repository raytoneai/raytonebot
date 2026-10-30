import { featureText } from "../../i18n/copy/features.ts";
import * as Dialog from "@radix-ui/react-dialog";
import { CircleSlash, X } from "lucide-react";
import { useRef, useState } from "react";
import { AgentAvatar, AgentPersonaProvider } from "../../avatars/AgentPersona";
import { botPartSVG } from "../../avatars/botAvatar";
import { useLocale } from "../../i18n/LocaleContext";
import { BOT_OPTIONS, BOT_PALETTE, DEFAULT_BOTS, DEFAULT_NEW_BOT } from "../../runtime/botAppearance";
import { BOT_KINDS, BOT_NAME_LIMIT, BOT_PERSONA_LIMITS, type BotProfile } from "../../runtime/botProfiles";
import { applyBotRoleTemplate, botRoleTemplates, type BotRoleTemplate } from "../../runtime/botRoleTemplates";
import { Button, Input } from "../ui";
import "../settings/settings.css";
import "./botEditor.css";

export type BotEditorState = {
  draft: BotProfile; creating: boolean; error?: string; saving?: boolean; ready?: boolean;
  onChange: (draft: BotProfile) => void;
  onSave: () => void; onClose: () => void;
  models?: { provider: string; model: string; label: string }[];
  mcpServers?: { id: string; name: string; enabled: boolean }[];
  skills?: { id: string; name: string; enabled: boolean }[];
};

/** The former settings avatar editor, shared by the Logo and every Bot's edit action. */
export function BotEditor({ draft, creating, error, saving = false, ready = true, models = [], mcpServers = [], skills = [], onChange, onSave, onClose }: BotEditorState) {
  const { locale } = useLocale();
  const kind = BOT_KINDS[draft.presetId];
  const opener = useRef(document.activeElement as HTMLElement | null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [template, setTemplate] = useState<BotRoleTemplate>();
  const labels = {
    face: featureText(locale, "Face"), hair: featureText(locale, "Hair"), accessory: featureText(locale, "Accessory"),
    faceColor: featureText(locale, "Face colour"), eyeColor: featureText(locale, "Eye colour"), hairColor: featureText(locale, "Hair colour"), accessoryColor: featureText(locale, "Accessory colour"),
  };
  const optionNames = {"round": "Round", "oval": "Oval", "soft-square": "Soft square", "none": "None", "quiff": "Quiff", "bob": "Bob", "pixie": "Pixie", "buns": "Buns", "long": "Long", "clip": "Clip", "bow": "Bow", "star": "Star", "glasses": "Glasses", "headphones": "Headphones", "headset": "Headset", "cap": "Cap", "beanie": "Beanie"} as const;
  const title = creating ? (featureText(locale, "Create Bot")) : (featureText(locale, "Edit Bot"));
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="settings-overlay" />
      <Dialog.Content className="settings-dialog bot-editor-dialog"
        onOpenAutoFocus={event => { event.preventDefault(); nameInput.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
        <header className="settings-body-header">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="settings-close" aria-label={featureText(locale, "Close")}><X size={16} /></Dialog.Close>
        </header>
        <form className="bot-editor-form" onSubmit={event => { event.preventDefault(); onSave(); }}>
          <div className="settings-body-scroll">
            <Dialog.Description className="settings-intro">{featureText(locale, "Set its role and communication style. Leave fields blank to keep the defaults. Changes apply from the next turn.")}</Dialog.Description>
            <div className="bot-creator">
              <div className="bot-creator-preview">
                <AgentPersonaProvider persona={{ kind, name: draft.name, state: "idle" }}>
                  <AgentAvatar size={160} kind={kind} appearance={draft.appearance} live interactive />
                </AgentPersonaProvider>
                <strong>{draft.name.trim() || (featureText(locale, "New Bot"))}</strong>
              </div>
              <div className="bot-creator-controls">
                <label className="bot-editor-field">{featureText(locale, "Name")}<Input ref={nameInput} value={draft.name} required maxLength={BOT_NAME_LIMIT}
                  placeholder={featureText(locale, "Name your Bot")} autoComplete="off" onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
                {creating ? <fieldset className="bot-options bot-role-templates" disabled={saving}>
                  <legend>{featureText(locale, "Start with a role")}</legend>
                  <div>{botRoleTemplates(locale).map(option => <button key={option.id} type="button" aria-pressed={template?.id === option.id}
                    onClick={() => { onChange(applyBotRoleTemplate(draft, option.persona, template?.persona)); setTemplate(option); }}>{option.label}</button>)}</div>
                  <p className="settings-note">{featureText(locale, "Optional starting text. Your own edits are preserved.")} {featureText(locale, "These editable templates use English instructions; replies follow your request’s language or the interface setting.")}</p>
                </fieldset> : null}
                {(["role", "personality", "instructions"] as const).map(key => <label key={key} className="bot-editor-field">
                  {({ role: featureText(locale, "Role and expertise"), personality: featureText(locale, "Personality and style"), instructions: featureText(locale, "Standing instructions") })[key]}
                  <textarea rows={key === "role" ? 2 : 3} value={draft[key] ?? ""} maxLength={BOT_PERSONA_LIMITS[key]} disabled={saving}
                    placeholder={({ role: featureText(locale, "For example: help with product research and check sources"), personality: featureText(locale, "For example: direct and patient; lead with the answer"), instructions: featureText(locale, "For example: separate facts from assumptions and cite key decisions") })[key]}
                    onChange={event => onChange({ ...draft, [key]: event.target.value })} />
                </label>)}
                <details className="bot-editor-capabilities"><summary>{featureText(locale, "Engine, model and capabilities")}</summary>
                  <label className="bot-editor-field">{featureText(locale, "Engine")}
                    <select value={draft.presetId} disabled={!creating || saving} onChange={event => onChange({ ...draft, presetId: event.target.value as BotProfile["presetId"] })}>
                      <option value="assistant">Pi</option><option value="planner">Claude Code</option><option value="builder">Codex CLI</option><option value="dsh">DeepSeek Harness</option>
                    </select>
                    <span className="settings-row-sub">{featureText(locale, "Separate chats; shares this engine's workspace and permissions.")}</span>
                  </label>
                  <label className="bot-editor-field">{featureText(locale, "Default model")}
                    <select value={draft.model ? JSON.stringify([draft.model.provider, draft.model.model]) : ""} disabled={saving}
                      onChange={event => { const pair = event.target.value ? JSON.parse(event.target.value) as [string, string] : undefined; onChange({ ...draft, model: pair ? { provider: pair[0], model: pair[1] } : undefined }); }}>
                      <option value="">{featureText(locale, "Follow the conversation")}</option>
                      {draft.model && !models.some(m => m.provider === draft.model!.provider && m.model === draft.model!.model) ? <option value={JSON.stringify([draft.model.provider, draft.model.model])}>{draft.model.model} ({featureText(locale, "unavailable")})</option> : null}
                      {models.map(m => <option key={JSON.stringify([m.provider, m.model])} value={JSON.stringify([m.provider, m.model])}>{m.label}</option>)}
                    </select>
                  </label>
                  <fieldset className="bot-options"><legend>MCP</legend>
                    <label className="bot-capability-option"><input type="checkbox" checked={draft.mcpServerIds === undefined} disabled={saving}
                      onChange={event => onChange({ ...draft, mcpServerIds: event.target.checked ? undefined : mcpServers.filter(s => s.enabled).map(s => s.id) })} />{featureText(locale, "Use all enabled servers")}</label>
                    {draft.mcpServerIds !== undefined ? mcpServers.map(server => <label key={server.id} className="bot-capability-option"><input type="checkbox" checked={draft.mcpServerIds!.includes(server.id)} disabled={saving}
                      onChange={event => onChange({ ...draft, mcpServerIds: event.target.checked ? [...draft.mcpServerIds!, server.id] : draft.mcpServerIds!.filter(id => id !== server.id) })} />{server.name}{!server.enabled ? (featureText(locale, " (disabled)")) : ""}</label>) : null}
                    {!mcpServers.length ? <p className="settings-note">{featureText(locale, "Add servers in Settings → MCP.")}</p> : null}
                  </fieldset>
                  <fieldset className="bot-options"><legend>Skills</legend>
                    {skills.map(skill => <label key={skill.id} className="bot-capability-option"><input type="checkbox" checked={draft.skillIds?.includes(skill.id) ?? false} disabled={saving}
                      onChange={event => onChange({ ...draft, skillIds: event.target.checked ? [...draft.skillIds ?? [], skill.id] : draft.skillIds?.filter(id => id !== skill.id) })} />{skill.name}{!skill.enabled ? (featureText(locale, " (disabled)")) : ""}</label>)}
                    {!skills.length ? <p className="settings-note">{featureText(locale, "Add instructions in Settings → MCP and Skills.")}</p> : null}
                  </fieldset>
                  {draft.presetId === "builder" ? <p className="settings-note">{featureText(locale, "New Codex tools become available in a new conversation; revoking existing tools takes effect immediately.")}</p> : null}
                </details>
                <details className="bot-editor-capabilities"><summary>{featureText(locale, "Avatar and appearance")}</summary>
                <Button type="button" variant="ghost" disabled={saving} onClick={() => onChange({ ...draft, appearance: { ...(draft.id === draft.presetId ? DEFAULT_BOTS[kind] : DEFAULT_NEW_BOT) } })}>{featureText(locale, "Default avatar")}</Button>
                {(Object.keys(BOT_OPTIONS) as (keyof typeof BOT_OPTIONS)[]).map(key => <fieldset key={key} className={`bot-options${key === "face" ? "" : " bot-part-options"}`} data-part={key}><legend>{labels[key]}</legend><div>
                  {BOT_OPTIONS[key].map(value => <button key={value} type="button" aria-label={featureText(locale, optionNames[value])} aria-pressed={draft.appearance[key] === value}
                    onClick={() => onChange({ ...draft, appearance: { ...draft.appearance, [key]: value } })}>
                    {key === "face" ? (featureText(locale, optionNames[value])) : value === "none" ? <CircleSlash size={20} aria-hidden="true" />
                      : <span className="bot-part-preview" aria-hidden="true" dangerouslySetInnerHTML={{ __html: botPartSVG(key, { ...draft.appearance, [key]: value }) }} />}
                  </button>)}
                </div></fieldset>)}
                <div className="bot-colours">{(["faceColor", "eyeColor", "hairColor", "accessoryColor"] as const).map(key => <label key={key}>{labels[key]}<input type="color" value={draft.appearance[key]}
                  onChange={event => onChange({ ...draft, appearance: { ...draft.appearance, [key]: event.target.value } })} /></label>)}</div>
                <fieldset className="bot-options"><legend>{featureText(locale, "Hair palette")}</legend><div>{[BOT_PALETTE.ink, BOT_PALETTE.claudeOrange, "#71869B", "#A9917E", "#D9D5C9"].map((color, i) => <button type="button" className="bot-swatch" key={color} style={{ background: color }}
                  aria-label={featureText(locale, (["Raytone navy", "Claude orange", "Slate", "Taupe", "Ivory"] as const)[i])}
                  aria-pressed={draft.appearance.hairColor.toLowerCase() === color.toLowerCase()} onClick={() => onChange({ ...draft, appearance: { ...draft.appearance, hairColor: color } })} />)}</div></fieldset>
                </details>
              </div>
            </div>
          </div>
          <footer className="bot-editor-footer">
            {error ? <p role="alert">{error}</p> : null}
            <div className="bot-actions"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{featureText(locale, "Cancel")}</Button><Button type="submit" disabled={!draft.name.trim() || saving || !ready}>{saving ? (featureText(locale, "Saving…")) : creating ? title : (featureText(locale, "Save"))}</Button></div>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
