import { useEffect, useRef, useState } from "react";
import { useRunStop } from "./runStop.ts";

export type ConversationRunLease = {
  id: string;
  controller: AbortController;
  isCurrent(): boolean;
  bind(runId?: string): void;
  prepared(): void;
  awaiting(value: boolean): void;
  accepted(): void;
  finish(options?: { handoff?: boolean }): void;
};

function update(setter: (next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => void, id: string, on: boolean) {
  setter(current => {
    if (current.has(id) === on) return current;
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
}

/** Owns local run identity and every UI status derived from that identity. */
export function useConversationRuns() {
  const controllers = useRef(new Map<string, AbortController>());
  const preparing = useRef(new Set<string>());
  const mounted = useRef(false);
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [awaitingIds, setAwaitingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [acceptingIds, setAcceptingIds] = useState<ReadonlySet<string>>(() => new Set());
  const stop = useRunStop(controllers, preparing);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const owned = [...controllers.current.values()];
      controllers.current.clear();
      preparing.current.clear();
      for (const controller of owned) controller.abort();
    };
  }, []);

  function acquire(id: string, options: { preparing?: boolean; accepting?: boolean; runId?: string } = {}): ConversationRunLease | undefined {
    if (!mounted.current || controllers.current.has(id)) return undefined;
    const controller = new AbortController();
    controllers.current.set(id, controller);
    if (options.preparing) preparing.current.add(id);
    setRunningIds(current => current.has(id) ? current : new Set(current).add(id));
    if (options.accepting) update(setAcceptingIds, id, true);
    stop.bind(controller, options.runId);
    // Abort stops transport, but this lease still owns local cancellation events until finish.
    const isCurrent = () => controllers.current.get(id) === controller;
    let finished = false;
    return {
      id, controller, isCurrent,
      bind: runId => { if (isCurrent()) stop.bind(controller, runId); },
      prepared: () => { if (isCurrent()) preparing.current.delete(id); },
      awaiting: value => { if (isCurrent()) update(setAwaitingIds, id, value); },
      accepted: () => { if (isCurrent()) update(setAcceptingIds, id, false); },
      finish: ({ handoff = false } = {}) => {
        if (finished) return;
        finished = true;
        if (controllers.current.get(id) !== controller) return;
        controllers.current.delete(id);
        preparing.current.delete(id);
        if (!handoff) {
          update(setRunningIds, id, false);
          update(setAwaitingIds, id, false);
          update(setAcceptingIds, id, false);
        }
      },
    };
  }

  return {
    acquire,
    has: (id: string) => controllers.current.has(id),
    runningIds, awaitingIds, acceptingIds,
    reconcileAwaiting(stored: readonly { id: string; running?: boolean; awaitingUser?: boolean }[]) {
      setAwaitingIds(current => {
        let next = current;
        for (const entry of stored) {
          const awaiting = Boolean(entry.awaitingUser);
          if (!awaiting && entry.running) continue;
          if (next.has(entry.id) === awaiting) continue;
          if (next === current) next = new Set(current);
          if (awaiting) (next as Set<string>).add(entry.id);
          else (next as Set<string>).delete(entry.id);
        }
        return next;
      });
    },
    stop: stop.stop,
    stopStatus: stop.statusFor,
  };
}
