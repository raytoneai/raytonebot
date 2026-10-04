import { useLayoutEffect, useRef, useState } from "react";
import { searchResultKey, type SearchSession } from "./useConversationSearch.ts";

const searchMetrics = { heading: 26, rowGap: 2, groupGap: 8, rowHeight: 36 };
// ponytail: measured rows, no index tree; a linear pass is sufficient for thousands of sessions/hits.
export function searchLayout(groups: readonly (readonly SearchSession[])[], heights: ReadonlyMap<string, number>, metrics = searchMetrics) {
  let top = 0, index = 0;
  return groups.map(items => {
    const start = top;
    if (items.length) top += metrics.heading;
    const rows = items.map(item => {
      const key = searchResultKey(item), height = heights.get(key) ?? (item.snippet ? 72 : metrics.rowHeight);
      const row = { item, key, index: index++, top, offset: top - start, height };
      top += height + metrics.rowGap;
      return row;
    });
    const height = top - start;
    if (items.length) top += metrics.groupGap;
    return { rows, height };
  });
}
type Row = ReturnType<typeof searchLayout>[number]["rows"][number];
export const visibleSearchRows = (rows: Row[], top: number, height: number, focused?: string) =>
  rows.filter(row => row.key === focused || (row.top + row.height >= top - 240 && row.top <= top + height + 240));

export function anchoredScrollTop(before: Row[], after: Row[], top: number) {
  const anchor = top > 0 && before.find(row => row.top + row.height > top);
  const next = anchor && after.find(row => row.key === anchor.key);
  return anchor && next ? top + next.top - anchor.top : top;
}

export function useSearchWindow(groups: readonly (readonly SearchSession[])[], query: string, metrics = searchMetrics) {
  const [list, setList] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [focused, setFocused] = useState<string>();
  const [heights, setHeights] = useState(new Map<string, number>());
  const pending = useRef<string>(undefined);
  const anchor = useRef<{ key: string; delta: number }>(undefined);
  const previous = useRef<{ list: HTMLElement; query: string; rows: Row[] }>(undefined);
  const layout = searchLayout(groups, heights, metrics), rows = layout.flatMap(group => group.rows);
  const current = useRef(rows); current.current = rows;
  const syncScroll = () => { if (list) setViewport({ top: list.scrollTop, height: list.clientHeight }); };
  const rememberAnchor = () => {
    const row = list && current.current.find(row => row.top + row.height > list.scrollTop);
    if (row && list) anchor.current = { key: row.key, delta: list.scrollTop - row.top };
  };
  const reveal = (row: Row) => {
    if (!list) return;
    if (row.top < list.scrollTop) list.scrollTop = row.top;
    else if (row.top + row.height > list.scrollTop + list.clientHeight)
      list.scrollTop = row.top + row.height - list.clientHeight;
    syncScroll();
  };
  const focus = (index: number) => {
    const row = current.current[index];
    if (!list || !row) return;
    pending.current = row.key;
    setFocused(row.key);
    reveal(row);
  };
  useLayoutEffect(() => {
    pending.current = undefined; anchor.current = undefined;
    setFocused(undefined); setHeights(new Map());
    if (list) list.scrollTop = 0;
    syncScroll();
  }, [list, query]);
  useLayoutEffect(() => {
    if (!list) return;
    let width = list.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== list.clientWidth) { rememberAnchor(); width = list.clientWidth; setHeights(new Map()); }
      syncScroll();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [list]);
  useLayoutEffect(() => {
    if (!list) return;
    if (!anchor.current && !pending.current && previous.current?.list === list && previous.current.query === query) {
      const top = anchoredScrollTop(previous.current.rows, rows, list.scrollTop);
      if (top !== list.scrollTop) { list.scrollTop = top; syncScroll(); }
    }
    previous.current = { list, query, rows };
    if (anchor.current) {
      const row = rows.find(row => row.key === anchor.current?.key);
      if (row) list.scrollTop = row.top + anchor.current.delta;
      anchor.current = undefined;
      syncScroll();
    }
    const elements = Array.from(list.querySelectorAll<HTMLElement>("[data-search-index]"));
    const changed = elements.flatMap(element => {
      const row = rows[Number(element.dataset.searchIndex)], height = element.parentElement!.getBoundingClientRect().height;
      return row && heights.get(row.key) !== height ? [[row.key, height] as const] : [];
    });
    if (changed.length) {
      rememberAnchor();
      setHeights(previous => new Map([...previous, ...changed]));
      return;
    }
    const row = rows.find(row => row.key === pending.current);
    if (row) {
      const element = elements.find(element => Number(element.dataset.searchIndex) === row.index);
      if (element) { pending.current = undefined; element.focus({ preventScroll: true }); reveal(row); }
    }
  });
  return { ref: setList, focus, onScroll: syncScroll,
    onFocus: (key?: string) => setFocused(key),
    groups: layout.map(group => ({ ...group, rows: visibleSearchRows(group.rows, viewport.top, viewport.height, focused) })),
    items: rows.map(row => row.item) };
}
