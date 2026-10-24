import { PiRequestError } from "../pi/piClient";
import { useRef, useState } from "react";
import type { AgentFrontendProject } from "../schema/agentuxConfig";
import { normalizeProviderSettings, providerIsAdded, providerValidationIssue, updateProviderSettings, type ProviderPatch } from "./providerSettings";

type Providers = AgentFrontendProject["providers"];
type Keys = Record<string, string>;
type Draft = { providers: Providers; keys: Keys; original: Providers; originalKeys: Keys; removeKeys: string[] };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Dialog-owned draft survives section changes; only an explicit successful save applies it. */
export function useProviderEditor(providers: Providers, keys: Keys, commit: (providers: Providers, keys: Keys, removeKeys: string[]) => void | Promise<void>) {
  const [draft, setDraft] = useState<Draft>();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const source = useRef({ providers, keys });
  source.current = { providers, keys };
  const current = draft?.providers ?? providers;
  const currentKeys = draft?.keys ?? keys;
  const dirty = Boolean(draft && (!same(draft.providers, providers) || !same(draft.keys, keys) || draft.removeKeys.length > 0));
  const invalid = current.connections.filter(providerIsAdded).map(provider => ({ provider, field: providerValidationIssue(provider) })).find(item => item.field);
  function edit(change: (value: Draft) => Draft) {
    if (pending.current) return;
    setStatus("idle");
    setDraft(value => change(value ?? { ...source.current, original: source.current.providers, originalKeys: source.current.keys, removeKeys: [] }));
  }
  function reset() { setRevision(value => value + 1); setDraft(undefined); setStatus("idle"); }
  async function save() {
    if (!draft || !dirty || invalid || pending.current) return false;
    if (!same(draft.original, providers) || !same(draft.originalKeys, keys)) { setStatus("conflict"); return false; }
    pending.current = true;
    setRevision(value => value + 1);
    setStatus("saving");
    try {
      await commit(normalizeProviderSettings(draft.providers), draft.keys, draft.removeKeys);
      setDraft(undefined);
      setStatus("saved");
      return true;
    } catch (error) { setStatus(error instanceof PiRequestError && error.status === 409 ? "conflict" : "failed"); return false; }
    finally { pending.current = false; }
  }
  return {
    providers: current, keys: currentKeys, removeKeys: draft?.removeKeys ?? [], dirty, invalid, status, revision, save, reset,
    update: (id: string, patch: ProviderPatch) => edit(value => ({ ...value, providers: updateProviderSettings(value.providers, id, patch), removeKeys: patch.baseUrl !== undefined ? value.removeKeys.filter(item => item !== id) : value.removeKeys })),
    setKey: (id: string, key: string) => edit(value => ({ ...value, keys: { ...value.keys, [id]: key }, removeKeys: value.removeKeys.filter(item => item !== id) })),
    toggleRemoveKey: (id: string) => edit(value => ({ ...value, keys: Object.fromEntries(Object.entries(value.keys).filter(([key]) => key !== id)), removeKeys: value.removeKeys.includes(id) ? value.removeKeys.filter(item => item !== id) : [...value.removeKeys, id] })),
    setDefault: (id: string) => edit(value => ({ ...value, providers: { ...value.providers, defaultProviderId: id } })),
  };
}
