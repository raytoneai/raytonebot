/** In-memory diagnostics: only correlated, decoded frames count; never retain input content. */
export function createBrowserLatencyTracker(clock = () => performance.now()) {
  const pending = new Map<string, number>();
  const samples: number[] = [];
  let missed = 0;
  return {
    begin(id: string) {
      pending.set(id, clock());
      if (pending.size > 200) { pending.delete(pending.keys().next().value!); missed++; }
    },
    displayed(id?: string) {
      const began = id ? pending.get(id) : undefined;
      if (began === undefined) return;
      pending.delete(id!);
      samples.push(Math.max(0, clock() - began));
      if (samples.length > 200) samples.shift();
    },
    reset() { missed += pending.size; pending.clear(); },
    summary() {
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (p: number) => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1]) : undefined;
      return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), pending: pending.size, missed };
    },
  };
}
