import * as Dialog from "@radix-ui/react-dialog";
import { CircleSlash, X } from "lucide-react";
import { useRef } from "react";
import { AgentAvatar, AgentPersonaProvider } from "../../avatars/AgentPersona";
import { botPartSVG } from "../../avatars/botAvatar";
import { useLocale } from "../../i18n/LocaleContext";
import { BOT_OPTIONS, BOT_PALETTE, DEFAULT_BOTS, DEFAULT_NEW_BOT } from "../../runtime/botAppearance";
import { BOT_KINDS, BOT_NAME_LIMIT, type BotProfile } from "../../runtime/botProfiles";
import { Button, Input } from "../ui";
import "../settings/settings.css";
import "./botEditor.css";

export type BotEditorState = {
  draft: BotProfile; creating: boolean; error?: string; saving?: boolean; ready?: boolean;
  onChange: (draft: BotProfile) => void;
  onSave: () => void; onClose: () => void;
};

/** The former settings avatar editor, shared by the Logo and every Bot's edit action. */
export function BotEditor({ draft, creating, error, saving = false, ready = true, onChange, onSave, onClose }: BotEditorState) {
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
            <Dialog.Description className="settings-intro">{zh ? "为 Bot 起个名字，搭配它的头像。名字和头像会同步到所有入口。" : "Give your Bot a name and a face. Names and avatars sync across all entry points."}</Dialog.Description>
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
                    <option value="assistant">Pi</option><option value="planner">Claude Code</option><option value="builder">Codex CLI</option>
                  </select>
                  <span className="settings-row-sub">{zh ? "独立聊天记录，共用该引擎的工作区与权限。" : "Separate chats; shares this engine's workspace and permissions."}</span>
                </label>
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
