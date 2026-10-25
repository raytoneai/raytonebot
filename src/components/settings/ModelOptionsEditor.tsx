import { useState } from "react";
import type { ProviderConnection } from "../../schema/agentuxConfig";
import type { ModelOptions } from "../../pi/modelMetadata";
import { useLocale } from "../../i18n/LocaleContext";
import { Button, Input } from "../ui";

/** Provider card helper; edits the same unsaved provider draft as the existing fields. */
export function ModelOptionsEditor({ provider, onChange }: { provider: ProviderConnection; onChange(options: Record<string, ModelOptions>): void }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [selected, setSelected] = useState("");
  // Keep removed model IDs reachable so the user can clear their saved options.
  const models = [...new Set([provider.defaultModel, ...provider.models, ...Object.keys(provider.modelOptions ?? {})])].filter(Boolean);
  const model = models.includes(selected) ? selected : provider.defaultModel;
  const value = provider.modelOptions && Object.hasOwn(provider.modelOptions, model) ? provider.modelOptions[model] : {};
  const update = (patch: Partial<ModelOptions>) => onChange({ ...provider.modelOptions, [model]: Object.fromEntries(Object.entries({ ...value, ...patch }).filter(([, v]) => v !== undefined)) });
  return <details className="settings-model-options"><summary>{zh ? "模型参数" : "Model options"}</summary>
    <p className="settings-note">{zh ? "按服务商文档填写。留空使用兼容默认值；只影响 Pi 的模型注册。" : "Use your provider's documented limits. Blank fields retain compatible defaults. These options configure Pi."}</p>
    <label className="bot-editor-field">{zh ? "配置的模型" : "Model"}<select value={model} onChange={event => setSelected(event.target.value)}>
      {models.map(id => <option key={id} value={id}>{id}{id !== provider.defaultModel && !provider.models.includes(id) ? (zh ? "（已移出模型列表）" : " (removed from model list)") : ""}</option>)}
    </select></label>
    <div className="settings-model-limits">
      <label className="bot-editor-field">{zh ? "上下文窗口（token）" : "Context window (tokens)"}<Input type="number" min={1} max={10_000_000} step={1} placeholder="128000" value={value.contextWindow ?? ""}
        onChange={event => update({ contextWindow: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
      <label className="bot-editor-field">{zh ? "最大输出（token）" : "Maximum output (tokens)"}<Input type="number" min={1} max={10_000_000} step={1} placeholder={String(Math.min(value.contextWindow ?? 128000, 16384))} value={value.maxTokens ?? ""}
        onChange={event => update({ maxTokens: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
      <label className="bot-editor-field">{zh ? "图片输入" : "Image input"}<select value={value.input === undefined ? "default" : value.input.includes("image") ? "yes" : "no"}
        onChange={event => update({ input: event.target.value === "default" ? undefined : event.target.value === "yes" ? ["text", "image"] : ["text"] })}>
        <option value="default">{zh ? "默认（支持）" : "Default (supported)"}</option><option value="yes">{zh ? "支持" : "Supported"}</option><option value="no">{zh ? "仅文本" : "Text only"}</option>
      </select></label>
      <label className="bot-editor-field">{zh ? "推理能力" : "Reasoning"}<select value={value.reasoning === undefined ? "default" : String(value.reasoning)}
        onChange={event => update({ reasoning: event.target.value === "default" ? undefined : event.target.value === "true" })}>
        <option value="default">{zh ? "沿用默认识别" : "Use existing defaults"}</option><option value="true">{zh ? "支持" : "Supported"}</option><option value="false">{zh ? "不支持" : "Not supported"}</option>
      </select></label>
    </div>
    <Button size="sm" variant="ghost" onClick={() => onChange(Object.fromEntries(Object.entries(provider.modelOptions ?? {}).filter(([id]) => id !== model)))}>{zh ? "恢复此模型默认参数" : "Reset this model's options"}</Button>
  </details>;
}
