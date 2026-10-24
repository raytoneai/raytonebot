import type { Layout } from "react-resizable-panels";

const STORAGE_KEY = "raytonebot.output-panel-layout";
type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

function validLayout(value: unknown): value is Layout {
  if (!value || typeof value !== "object") return false;
  const { main, output } = value as Layout;
  return Object.keys(value).length === 2 && Number.isFinite(main) && Number.isFinite(output)
    && main > 0 && output > 0 && Math.abs(main + output - 100) < 0.01;
}

export function readOutputPanelLayout(storage?: LayoutStorage): Layout | undefined {
  try {
    const layout: unknown = JSON.parse((storage ?? window.localStorage).getItem(STORAGE_KEY) ?? "null");
    return validLayout(layout) ? layout : undefined;
  } catch { return undefined; }
}

/** Only user resizes reach here; responsive constraints must not overwrite their preference. */
export function saveOutputPanelLayout(layout: Layout, storage?: LayoutStorage): void {
  if (!validLayout(layout)) return;
  try { (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(layout)); }
  catch { /* Resizing still works when browser storage is unavailable. */ }
}
