import type { ScaffoldExportSnapshot } from "../../export/scaffoldManifest";

/**
 * Stub. In AgentCanvas this panel downloads the scaffold zip; an exported app has
 * nothing to export, but `slots/slotRegistry.tsx` is an exhaustive registry over
 * every SlotConfig component, so the module has to exist. The "ExportFrame" slot is
 * not part of an exported layout, so this never renders.
 */
export function ExportFrame(_props: { snapshot?: ScaffoldExportSnapshot; onExport: () => void }) {
  return null;
}
