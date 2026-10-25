import { useCallback, useEffect, useRef, useState } from "react";

import { deleteSkill, getSkills, saveSkill } from "../pi/piClient";
import type { SkillInput, SkillState } from "../pi/skillTypes";

export type SkillsState = {
  state?: SkillState;
  error?: string;
  busy?: string;
  actionError?: { id: string; message: string };
  refresh(): Promise<void>;
  save(input: SkillInput): Promise<boolean>;
  remove(id: string): Promise<boolean>;
};

/** The host owns the library and revisions; the inline editor owns unsaved text. */
export function useSkills(active: boolean): SkillsState {
  const [state, setState] = useState<SkillState>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<SkillsState["actionError"]>();
  const current = useRef<SkillState | undefined>(undefined);
  const locked = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const accept = useCallback((value: SkillState) => {
    if (!mounted.current || current.current && value.revision < current.current.revision) return;
    current.current = value;
    setState(value);
    setError(undefined);
  }, []);
  const refresh = useCallback(async () => {
    if (locked.current) return;
    const request = ++generation.current;
    try {
      const value = await getSkills();
      if (request === generation.current) accept(value);
    } catch (failure) {
      if (mounted.current && request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [accept]);
  useEffect(() => {
    if (active) void refresh();
    return () => { generation.current++; };
  }, [active, refresh]);
  const act = useCallback(async (id: string, action: (revision: number) => Promise<SkillState>) => {
    if (locked.current || !current.current) return false;
    locked.current = true;
    generation.current++;
    setBusy(id);
    setActionError(undefined);
    try {
      accept(await action(current.current.revision));
      return true;
    } catch (failure) {
      if (mounted.current) setActionError({ id, message: failure instanceof Error ? failure.message : String(failure) });
      // A conflict updates the library revision, never the editor's unsaved draft or the request.
      try { accept(await getSkills()); } catch { /* Keep the original action error visible. */ }
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }, [accept]);
  return {
    state, error, busy, actionError, refresh,
    save: input => act(input.id ?? "new", revision => saveSkill(input, revision)),
    remove: id => act(id, revision => deleteSkill(id, revision)),
  };
}
