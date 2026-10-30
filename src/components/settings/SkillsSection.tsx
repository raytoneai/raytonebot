import { Plus } from "lucide-react";
import { useState } from "react";

import { useLocale } from "../../i18n/LocaleContext";
import { SKILL_COUNT_LIMIT, SKILL_DESCRIPTION_LIMIT, SKILL_INSTRUCTIONS_LIMIT, SKILL_NAME_LIMIT, type Skill } from "../../pi/skillTypes";
import type { SkillsState } from "../../runtime/useSkills";
import { Button, Input, Switch, Textarea } from "../ui";

const copy = {
  zh: {
    title: "Skills", intro: "保存可复用的工作方法，在 Bot 设置中选择要分配的 Skills。Bot 会在任务需要时读取完整说明。",
    empty: "还没有 Skills。", loading: "正在读取 Skills…", add: "添加 Skill", edit: "编辑", remove: "删除", confirm: "确认删除",
    name: "名称", description: "适用场景", instructions: "操作说明", enabled: "启用", disabled: "已停用", save: "保存", saving: "保存中…", cancel: "取消", refresh: "重新读取",
    hint: "说明仅作为任务指导；当前请求和权限设置仍然生效。", draft: "未保存的内容已保留。请检查最新列表和草稿后重新保存。",
  },
  ja: {
    title: "Skills", intro: "再利用できる作業手順を保存し、各 Bot の設定で割り当てます。Bot はタスクに必要なときに詳細な手順を読み込みます。",
    empty: "Skills はまだありません。", loading: "Skills を読み込み中…", add: "Skill を追加", edit: "編集", remove: "削除", confirm: "削除を確定",
    name: "名前", description: "使用する場面", instructions: "手順", enabled: "有効", disabled: "無効", save: "保存", saving: "保存中…", cancel: "キャンセル", refresh: "再読み込み",
    hint: "手順はタスクの指針です。現在のリクエストと権限設定が引き続き適用されます。", draft: "未保存の内容は保持されています。最新の一覧と下書きを確認してから保存し直してください。",
  },
  en: {
    title: "Skills", intro: "Save reusable working instructions, then assign them in each Bot's settings. The Bot reads the full instructions when they fit the task.",
    empty: "No Skills yet.", loading: "Loading Skills…", add: "Add Skill", edit: "Edit", remove: "Delete", confirm: "Confirm delete",
    name: "Name", description: "When to use", instructions: "Instructions", enabled: "Enabled", disabled: "Disabled", save: "Save", saving: "Saving…", cancel: "Cancel", refresh: "Reload",
    hint: "Instructions guide the task; the current request and permission settings still apply.", draft: "Your unsaved text is preserved. Review the latest list and your draft before saving again.",
  },
};

/** Owned and rendered only by SettingsDialog's existing MCP section. */
export function SkillsSection({ state }: { state: SkillsState }) {
  const { locale } = useLocale();
  const c = copy[locale];
  const [editing, setEditing] = useState<Skill | "new">();
  const [confirming, setConfirming] = useState<string>();
  const busy = Boolean(state.busy);
  const editId = editing === "new" ? "new" : editing?.id;
  return (
    <section className="settings-skills" aria-label={c.title}>
      <h3>{c.title}</h3>
      <p className="settings-intro">{c.intro}</p>
      {state.error ? <p className="settings-status" data-tone="error" role="alert">{state.error}</p> : null}
      {!state.state && !state.error ? <p className="settings-note" role="status">{c.loading}</p> : null}
      {state.state?.skills.length === 0 && !editing ? <p className="settings-note">{c.empty}</p> : null}
      {state.state?.skills.length ? <div className="settings-list">
        {state.state.skills.map(skill => <div className="settings-provider" key={skill.id}>
          <div className="settings-row settings-vault-row">
            <span className="settings-row-main">
              <span className="settings-row-title"><strong>{skill.name}</strong></span>
              <span className="settings-row-sub">{skill.description || (skill.enabled ? c.enabled : c.disabled)}</span>
            </span>
            <Switch size="sm" aria-label={`${skill.name} ${c.enabled}`} checked={skill.enabled} disabled={busy || Boolean(editing)}
              onCheckedChange={enabled => void state.save({ id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, enabled })} />
            <Button size="sm" variant="ghost" disabled={busy || Boolean(editing)} onClick={() => { setEditing(skill); setConfirming(undefined); }}>{c.edit}</Button>
            <Button size="sm" variant="ghost" disabled={busy || Boolean(editing)} onBlur={() => setConfirming(undefined)} onClick={async () => {
              if (confirming !== skill.id) { setConfirming(skill.id); return; }
              if (await state.remove(skill.id)) setConfirming(undefined);
            }}>{confirming === skill.id ? c.confirm : c.remove}</Button>
          </div>
          {state.actionError?.id === skill.id && editId !== skill.id ? <p className="settings-status settings-provider-editor" data-tone="error" role="alert">{state.actionError.message}</p> : null}
        </div>)}
      </div> : null}
      {editing ? <SkillEditor key={editId} skill={editing === "new" ? undefined : editing} state={state} onClose={() => setEditing(undefined)} /> : null}
      <div className="settings-provider-actions settings-vault-actions">
        <Button size="sm" variant="ghost" disabled={busy || Boolean(editing) || !state.state || state.state.skills.length >= SKILL_COUNT_LIMIT}
          onClick={() => { setEditing("new"); setConfirming(undefined); }}><Plus size={14} aria-hidden="true" />{c.add}</Button>
        {state.error ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void state.refresh()}>{c.refresh}</Button> : null}
      </div>
    </section>
  );
}

function SkillEditor({ skill, state, onClose }: { skill?: Skill; state: SkillsState; onClose(): void }) {
  const { locale } = useLocale();
  const c = copy[locale];
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const busy = Boolean(state.busy);
  const failure = state.actionError?.id === (skill?.id ?? "new") ? state.actionError.message : undefined;
  const save = async () => {
    if (busy || !name.trim() || !instructions.trim()) return;
    if (await state.save({ id: skill?.id, name, description, instructions, enabled })) onClose();
  };
  return (
    <div className="settings-add" role="group" aria-label={skill ? `${c.edit} ${skill.name}` : c.add}>
      <div className="settings-add-head"><strong>{skill ? `${c.edit} ${skill.name}` : c.add}</strong></div>
      <label className="settings-field"><span className="settings-field-label">{c.name}</span><span className="settings-field-control">
        <Input aria-label={c.name} autoFocus value={name} maxLength={SKILL_NAME_LIMIT} disabled={busy} onChange={event => setName(event.target.value)} />
      </span></label>
      <label className="settings-field"><span className="settings-field-label">{c.description}</span><span className="settings-field-control">
        <Input aria-label={c.description} value={description} maxLength={SKILL_DESCRIPTION_LIMIT} disabled={busy} onChange={event => setDescription(event.target.value)} />
      </span></label>
      <label className="settings-field"><span className="settings-field-label">{c.instructions}</span><span className="settings-field-control">
        <Textarea aria-label={c.instructions} value={instructions} rows={10} maxLength={SKILL_INSTRUCTIONS_LIMIT} disabled={busy} spellCheck={false} onChange={event => setInstructions(event.target.value)} />
        <small className="settings-note">{instructions.length.toLocaleString()} / {SKILL_INSTRUCTIONS_LIMIT.toLocaleString()}</small>
      </span></label>
      <div className="settings-provider-actions"><Switch size="sm" aria-label={c.enabled} checked={enabled} disabled={busy} onCheckedChange={setEnabled} /><span className="settings-note">{enabled ? c.enabled : c.disabled}</span></div>
      <p className="settings-note">{c.hint}</p>
      {failure ? <p className="settings-status" data-tone="error" role="alert">{failure} {c.draft}</p> : null}
      <div className="settings-provider-actions">
        <Button size="sm" disabled={busy || !name.trim() || !instructions.trim()} onClick={() => void save()}>{busy ? c.saving : c.save}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{c.cancel}</Button>
      </div>
    </div>
  );
}
