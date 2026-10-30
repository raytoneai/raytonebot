import { featureText } from "../../i18n/copy/features.ts";
import { useState } from "react";
import type { ProviderConnection } from "../../schema/agentuxConfig";
import type { ModelOptions } from "../../pi/modelMetadata";
import { useLocale } from "../../i18n/LocaleContext";
import { Button, Input } from "../ui";

/** Provider card helper; edits the same unsaved provider draft as the existing fields. */
export function ModelOptionsEditor({ provider, onChange }: { provider: ProviderConnection; onChange(options: Record<string, ModelOptions>): void }) {
  const { locale } = useLocale();
  const [selected, setSelected] = useState("");
  // Keep removed model IDs reachable so the user can clear their saved options.
  const models = [...new Set([provider.defaultModel, ...provider.models, ...Object.keys(provider.modelOptions ?? {})])].filter(Boolean);
  const model = models.includes(selected) ? selected : provider.defaultModel;
  const value = provider.modelOptions && Object.hasOwn(provider.modelOptions, model) ? provider.modelOptions[model] : {};
  const update = (patch: Partial<ModelOptions>) => onChange({ ...provider.modelOptions, [model]: Object.fromEntries(Object.entries({ ...value, ...patch }).filter(([, v]) => v !== undefined)) });
  return <details className="settings-model-options"><summary>{featureText(locale, "Model options")}</summary>
    <p className="settings-note">{featureText(locale, "Use your provider's documented limits. Blank fields retain compatible defaults. These options configure Pi.")}</p>
    <label className="bot-editor-field">{featureText(locale, "Model")}<select value={model} onChange={event => setSelected(event.target.value)}>
      {models.map(id => <option key={id} value={id}>{id}{id !== provider.defaultModel && !provider.models.includes(id) ? (featureText(locale, " (removed from model list)")) : ""}</option>)}
    </select></label>
    <div className="settings-model-limits">
      <label className="bot-editor-field">{featureText(locale, "Context window (tokens)")}<Input type="number" min={1} max={10_000_000} step={1} placeholder="128000" value={value.contextWindow ?? ""}
        onChange={event => update({ contextWindow: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
      <label className="bot-editor-field">{featureText(locale, "Maximum output (tokens)")}<Input type="number" min={1} max={10_000_000} step={1} placeholder={String(Math.min(value.contextWindow ?? 128000, 16384))} value={value.maxTokens ?? ""}
        onChange={event => update({ maxTokens: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
      <label className="bot-editor-field">{featureText(locale, "Image input")}<select value={value.input === undefined ? "default" : value.input.includes("image") ? "yes" : "no"}
        onChange={event => update({ input: event.target.value === "default" ? undefined : event.target.value === "yes" ? ["text", "image"] : ["text"] })}>
        <option value="default">{featureText(locale, "Default (supported)")}</option><option value="yes">{featureText(locale, "Supported")}</option><option value="no">{featureText(locale, "Text only")}</option>
      </select></label>
      <label className="bot-editor-field">{featureText(locale, "Reasoning")}<select value={value.reasoning === undefined ? "default" : String(value.reasoning)}
        onChange={event => update({ reasoning: event.target.value === "default" ? undefined : event.target.value === "true" })}>
        <option value="default">{featureText(locale, "Use existing defaults")}</option><option value="true">{featureText(locale, "Supported")}</option><option value="false">{featureText(locale, "Not supported")}</option>
      </select></label>
    </div>
    <Button size="sm" variant="ghost" onClick={() => onChange(Object.fromEntries(Object.entries(provider.modelOptions ?? {}).filter(([id]) => id !== model)))}>{featureText(locale, "Reset this model's options")}</Button>
  </details>;
}
