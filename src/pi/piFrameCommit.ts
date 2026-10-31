/** Coalesce streamed conversation snapshots to one React commit per animation frame. */
export type PiFrameCommit<T> = {
  /** Queue a value. The most recent one is what gets committed. */
  push(value: T): void;
  /** Commit any queued value now — call at the end of a turn so nothing waits on a frame. */
  flush(): void;
  /** Drop any queued value without committing, for an aborted turn. */
  cancel(): void;
};

export function createPiFrameCommit<T>(commit: (value: T) => void): PiFrameCommit<T> {
  let pending: { value: T } | undefined;
  let handle: number | undefined;

  // Absent under SSR and in the test environment. Committing straight through keeps behaviour
  // identical there instead of silently swallowing every update.
  const schedule = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : undefined;

  const commitPending = () => {
    const next = pending;
    pending = undefined;
    if (next) commit(next.value);
  };

  return {
    push(value) {
      if (!schedule) {
        commit(value);
        return;
      }
      pending = { value };
      if (handle !== undefined) return;
      handle = schedule(() => {
        handle = undefined;
        commitPending();
      });
    },
    flush() {
      if (handle !== undefined) {
        cancelAnimationFrame(handle);
        handle = undefined;
      }
      commitPending();
    },
    cancel() {
      if (handle !== undefined) {
        cancelAnimationFrame(handle);
        handle = undefined;
      }
      pending = undefined;
    },
  };
}
