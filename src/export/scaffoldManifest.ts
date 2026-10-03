/**
 * Type-only stub. `slots/slotRegistry.tsx` type-imports ScaffoldExportSnapshot from
 * here; the real export pipeline is deliberately not shipped (it globs the source tree
 * and reads node:fs). Nothing in an exported app produces one of these values.
 */
export type ScaffoldExportSnapshot = {
  packageJson: unknown;
  agentuxConfig: unknown;
  files: string[];
  fileContents: Record<string, string>;
};
