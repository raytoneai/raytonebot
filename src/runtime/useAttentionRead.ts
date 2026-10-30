import { useCallback, useEffect, useState } from "react";

const KEY = "raytonebot.viewedResults";
type ViewedResults = Record<string, string[]>;

/** Keep identities rather than ordering by host time: clocks and legacy timestamps can tie. */
export function mergeViewedResults(current: ViewedResults, persisted: ViewedResults, id: string, token: string): ViewedResults {
  const next: ViewedResults = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(persisted), id])) {
    next[key] = [...new Set([...(current[key] ?? []), ...(persisted[key] ?? []), ...(key === id ? [token] : [])])];
  }
  return Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([key, values]) =>
    current[key]?.length === values.length && values.every(value => current[key].includes(value))) ? current : next;
}

function read(): ViewedResults {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([id]) => id.length <= 180).map(([id, tokens]) => [id,
        (Array.isArray(tokens) ? tokens : [tokens]).filter((token): token is string => typeof token === "string" && token.length <= 1000)])) : {};
  } catch { return {}; }
}

/** Browser-owned read receipts contain identities only; they never start work or alter history. */
export function useAttentionRead() {
  const [seen, setSeen] = useState(read);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === KEY) setSeen(read()); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const mark = useCallback((id: string, token: string) => {
    setSeen(current => {
      if (current[id]?.includes(token)) return current;
      const next = mergeViewedResults(current, read(), id, token);
      if (next === current) return current;
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Read state still works for this page. */ }
      return next;
    });
  }, []);
  return { seen, mark };
}
