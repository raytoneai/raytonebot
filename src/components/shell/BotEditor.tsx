import * as Dialog from "@radix-ui/react-dialog";
import { CircleSlash, X } from "lucide-react";
import { useRef } from "react";
import { AgentAvatar, AgentPersonaProvider } from "../../avatars/AgentPersona";
import { botPartSVG } from "../../avatars/botAvatar";
import { useLocale } from "../../i18n/LocaleContext";
import { BOT_OPTIONS, BOT_PALETTE, DEFAULT_BOTS, DEFAULT_NEW_BOT } from "../../runtime/botAppearance";
import { BOT_KINDS, BOT_NAME_LIMIT, BOT_PERSONA_LIMITS, type BotProfile } from "../../runtime/botProfiles";
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
  const zh = locale === "zh";
  const kind = BOT_KINDS[draft.presetId];
  const opener = useRef(document.activeElement as HTMLElement | null);
  const nameInput = useRef<HTMLInputElement>(null);
  const labels = {
    face: zh ? "脸蛋" : "Face", hair: zh ? "头发" : "Hair", accessory: zh ? "配饰" : "Accessory",
    faceColor: zh ? "脸蛋颜色" : "Face colour", eyeColor: zh ? "眼睛颜色" : "Eye colour", hairColor: zh ? "头发颜色" : "Hair colour", accessoryColor: zh ? "配饰颜色" : "Accessory colour",
  };
  const optionNames: Record<string, string> = { round: "圆形", oval: "椭圆", "soft-square": "圆角方形", none: "无", quiff: "飞机头", bob: "波波头", pixie: "侧分短发", buns: "双丸子", long: "侧分长发", clip: "发夹", bow: "蝴蝶结", star: "星星", glasses: "圆眼镜", headphones: "头戴耳机", headset: "耳麦", cap: "棒球帽", beanie: "针织帽" };
  const title = creating ? (zh ? "创建 Bot" : "Create Bot") : (zh ? "编辑 Bot" : "Edit Bot");
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="settings-overlay" />
      <Dialog.Content className="settings-dialog bot-editor-dialog"
        onOpenAutoFocus={event => { event.preventDefault(); nameInput.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
        <header className="settings-body-header">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close className="settings-close" aria-label={zh ? "关闭" : "Close"}><X size={16} /></Dialog.Close>
        </header>
        <form className="bot-editor-form" onSubmit={event => { event.preventDefault(); onSave(); }}>
          <div className="settings-body-scroll">
            <Dialog.Description className="settings-intro">{zh ? "设定它的职责和表达习惯，留空的项目沿用默认设置。保存后在下一轮对话生效。" : "Set its role and communication style. Leave fields blank to keep the defaults. Changes apply from the next turn."}</Dialog.Description>
            <div className="bot-creator">
              <div className="bot-creator-preview">
                <AgentPersonaProvider persona={{ kind, name: draft.name, state: "idle" }}>
                  <AgentAvatar size={160} kind={kind} appearance={draft.appearance} live interactive />
                </AgentPersonaProvider>
                <strong>{draft.name.trim() || (zh ? "新 Bot" : "New Bot")}</strong>
                <Button type="button" variant="ghost" onClick={() => onChange({ ...draft, appearance: { ...(draft.id === draft.presetId ? DEFAULT_BOTS[kind] : DEFAULT_NEW_BOT) } })}>{zh ? "恢复默认头像" : "Default avatar"}</Button>
              </div>
              <div className="bot-creator-controls">
                <label className="bot-editor-field">{zh ? "名字" : "Name"}<Input ref={nameInput} value={draft.name} required maxLength={BOT_NAME_LIMIT}
                  placeholder={zh ? "给 Bot 起个名字" : "Name your Bot"} autoComplete="off" onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
                <label className="bot-editor-field">{zh ? "引擎" : "Engine"}
                  <select value={draft.presetId} disabled={!creating} onChange={event => onChange({ ...draft, presetId: event.target.value as BotProfile["presetId"] })}>
                    <option value="assistant">Pi</option><option value="planner">Claude Code</option><option value="builder">Codex CLI</option><option value="dsh">DeepSeek Harness</option>
                  </select>
                  <span className="settings-row-sub">{zh ? "独立聊天记录，共用该引擎的工作区与权限。" : "Separate chats; shares this engine's workspace and permissions."}</span>
                </label>
                {(["role", "personality", "instructions"] as const).map(key => <label key={key} className="bot-editor-field">
                  {({ role: zh ? "职责与专长" : "Role and expertise", personality: zh ? "性格与表达习惯" : "Personality and style", instructions: zh ? "长期要求" : "Standing instructions" })[key]}
                  <textarea rows={key === "role" ? 2 : 3} value={draft[key] ?? ""} maxLength={BOT_PERSONA_LIMITS[key]} disabled={saving}
                    placeholder={({ role: zh ? "例如：帮助我做产品研究，核实信息来源" : "For example: help with product research and check sources", personality: zh ? "例如：直接、耐心，先给结论，使用简洁中文" : "For example: direct and patient; lead with the answer", instructions: zh ? "例如：区分事实和假设，保留重要决定的依据" : "For example: separate facts from assumptions and cite key decisions" })[key]}
                    onChange={event => onChange({ ...draft, [key]: event.target.value })} />
                </label>)}
                <details className="bot-editor-capabilities"><summary>{zh ? "模型与能力" : "Model and capabilities"}</summary>
                  <label className="bot-editor-field">{zh ? "默认模型" : "Default model"}
                    <select value={draft.model ? JSON.stringify([draft.model.provider, draft.model.model]) : ""} disabled={saving}
                      onChange={event => { const pair = event.target.value ? JSON.parse(event.target.value) as [string, string] : undefined; onChange({ ...draft, model: pair ? { provider: pair[0], model: pair[1] } : undefined }); }}>
                      <option value="">{zh ? "跟随当前对话" : "Follow the conversation"}</option>
                      {draft.model && !models.some(m => m.provider === draft.model!.provider && m.model === draft.model!.model) ? <option value={JSON.stringify([draft.model.provider, draft.model.model])}>{draft.model.model} ({zh ? "服务不可用" : "unavailable"})</option> : null}
                      {models.map(m => <option key={JSON.stringify([m.provider, m.model])} value={JSON.stringify([m.provider, m.model])}>{m.label}</option>)}
                    </select>
                  </label>
                  <fieldset className="bot-options"><legend>MCP</legend>
                    <label className="bot-capability-option"><input type="checkbox" checked={draft.mcpServerIds === undefined} disabled={saving}
                      onChange={event => onChange({ ...draft, mcpServerIds: event.target.checked ? undefined : mcpServers.filter(s => s.enabled).map(s => s.id) })} />{zh ? "使用全部已启用服务" : "Use all enabled servers"}</label>
                    {draft.mcpServerIds !== undefined ? mcpServers.map(server => <label key={server.id} className="bot-capability-option"><input type="checkbox" checked={draft.mcpServerIds!.includes(server.id)} disabled={saving}
                      onChange={event => onChange({ ...draft, mcpServerIds: event.target.checked ? [...draft.mcpServerIds!, server.id] : draft.mcpServerIds!.filter(id => id !== server.id) })} />{server.name}{!server.enabled ? (zh ? "（已停用）" : " (disabled)") : ""}</label>) : null}
                    {!mcpServers.length ? <p className="settings-note">{zh ? "在设置的 MCP 中添加服务。" : "Add servers in Settings → MCP."}</p> : null}
                  </fieldset>
                  <fieldset className="bot-options"><legend>Skills</legend>
                    {skills.map(skill => <label key={skill.id} className="bot-capability-option"><input type="checkbox" checked={draft.skillIds?.includes(skill.id) ?? false} disabled={saving}
                      onChange={event => onChange({ ...draft, skillIds: event.target.checked ? [...draft.skillIds ?? [], skill.id] : draft.skillIds?.filter(id => id !== skill.id) })} />{skill.name}{!skill.enabled ? (zh ? "（已停用）" : " (disabled)") : ""}</label>)}
                    {!skills.length ? <p className="settings-note">{zh ? "在设置的 MCP 与 Skills 中添加工作方法。" : "Add instructions in Settings → MCP and Skills."}</p> : null}
                  </fieldset>
                  {draft.presetId === "builder" ? <p className="settings-note">{zh ? "Codex 新增工具需新建对话后使用；已有工具的撤销立即生效。" : "New Codex tools become available in a new conversation; revoking existing tools takes effect immediately."}</p> : null}
                </details>
                {(Object.keys(BOT_OPTIONS) as (keyof typeof BOT_OPTIONS)[]).map(key => <fieldset key={key} className={`bot-options${key === "face" ? "" : " bot-part-options"}`} data-part={key}><legend>{labels[key]}</legend><div>
                  {BOT_OPTIONS[key].map(value => <button key={value} type="button" aria-label={zh ? optionNames[value] : value} aria-pressed={draft.appearance[key] === value}
                    onClick={() => onChange({ ...draft, appearance: { ...draft.appearance, [key]: value } })}>
                    {key === "face" ? (zh ? optionNames[value] : value) : value === "none" ? <CircleSlash size={20} aria-hidden="true" />
                      : <span className="bot-part-preview" aria-hidden="true" dangerouslySetInnerHTML={{ __html: botPartSVG(key, { ...draft.appearance, [key]: value }) }} />}
                  </button>)}
                </div></fieldset>)}
                <div className="bot-colours">{(["faceColor", "eyeColor", "hairColor", "accessoryColor"] as const).map(key => <label key={key}>{labels[key]}<input type="color" value={draft.appearance[key]}
                  onChange={event => onChange({ ...draft, appearance: { ...draft.appearance, [key]: event.target.value } })} /></label>)}</div>
                <fieldset className="bot-options"><legend>{zh ? "推荐发色" : "Hair palette"}</legend><div>{[BOT_PALETTE.ink, BOT_PALETTE.claudeOrange, "#71869B", "#A9917E", "#D9D5C9"].map((color, i) => <button type="button" className="bot-swatch" key={color} style={{ background: color }}
                  aria-label={(zh ? ["Raytone 深蓝", "Claude 橙", "灰蓝", "暖棕", "米白"] : ["Raytone navy", "Claude orange", "Slate", "Taupe", "Ivory"])[i]}
                  aria-pressed={draft.appearance.hairColor.toLowerCase() === color.toLowerCase()} onClick={() => onChange({ ...draft, appearance: { ...draft.appearance, hairColor: color } })} />)}</div></fieldset>
              </div>
            </div>
          </div>
          <footer className="bot-editor-footer">
            {error ? <p role="alert">{error}</p> : null}
            <div className="bot-actions"><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{zh ? "取消" : "Cancel"}</Button><Button type="submit" disabled={!draft.name.trim() || saving || !ready}>{saving ? (zh ? "保存中…" : "Saving…") : creating ? title : (zh ? "保存" : "Save")}</Button></div>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
