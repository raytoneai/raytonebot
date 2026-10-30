/** Execution time excludes time spent waiting for a person's approval. */
export function createRunDeadline(durationMs: number, expire: () => void) {
  let remaining = durationMs, resumedAt = Date.now(), paused = false, disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const remainingMs = () => Math.max(0, remaining - (paused ? 0 : Date.now() - resumedAt));
  const schedule = () => { timer = setTimeout(expire, remainingMs()); timer.unref(); };
  schedule();
  return {
    remainingMs,
    setPaused(value: boolean) {
      if (disposed || value === paused) return;
      remaining = remainingMs();
      clearTimeout(timer);
      paused = value;
      resumedAt = Date.now();
      if (!paused || remaining === 0) schedule();
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
